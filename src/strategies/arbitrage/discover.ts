// src/strategies/arbitrage/discover.ts

import { ethers } from 'ethers';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider, executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { getAllVenueQuotes, findBestVenueSpread } from '../../scanner/sources/ensoMultiVenue';
import { TOKENS, TokenInfo } from '../../config/tokens';

const log = createLogger('arbitrage');

// ============================================
// RATE LIMITING (Global)
// ============================================

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 150; // ~6.6 requests per second

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ============================================
// CACHE (within scan cycle)
// ============================================

interface CachedQuote {
  data: any;
  timestamp: number;
  failed: boolean;
}

const quoteCache = new Map<string, CachedQuote>();
const CACHE_TTL_MS = 60000; // 1 minute

function getCacheKey(tokenIn: string, tokenOut: string, amountIn: string): string {
  return `${tokenIn}-${tokenOut}-${amountIn}`;
}

async function getCachedQuote(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  skipCache: boolean = false
): Promise<any | null> {
  const key = getCacheKey(tokenIn.address, tokenOut.address, amountIn);
  if (!skipCache && quoteCache.has(key)) {
    const entry = quoteCache.get(key)!;
    if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
      if (entry.failed) return null;
      return entry.data;
    } else {
      quoteCache.delete(key);
    }
  }
  await rateLimit();
  try {
    const quote = await getEnsoRouteQuote(tokenIn, tokenOut, amountIn);
    if (quote) {
      quoteCache.set(key, { data: quote, timestamp: Date.now(), failed: false });
      return quote;
    } else {
      quoteCache.set(key, { data: null, timestamp: Date.now(), failed: true });
      return null;
    }
  } catch (err) {
    quoteCache.set(key, { data: null, timestamp: Date.now(), failed: true });
    return null;
  }
}

// ============================================
// TYPES
// ============================================

interface ArbitrageResult {
  type: 'triangular' | 'crossdex';
  tokenPath: string[];
  startUsd: number;
  endUsd: number;
  grossProfitUsd: number;
  gasCostUsd: number;
  flashloanFeeUsd: number;
  netProfitUsd: number;
  details: any;
}

// ============================================
// FLASHLOAN SIMULATION (Aave V3 fee = 0.09%)
// ============================================

async function simulateFlashloanArbitrage(
  amountUsd: number,
  nativePriceUsd: number,
  flashloanFeeBps: number = 9 // Aave V3 = 0.09% = 9 bps
): Promise<{
  gasCostUsd: number;
  flashloanFeeUsd: number;
  totalCostUsd: number;
}> {
  const gasPrice = await provider.getGasPrice();
  const gasUnits = ethers.BigNumber.from(400000); // reduced from 600k
  const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasUnits)));
  const gasCostUsd = gasCostNative * nativePriceUsd;
  const flashloanFeeUsd = amountUsd * (flashloanFeeBps / 10000);
  return {
    gasCostUsd,
    flashloanFeeUsd,
    totalCostUsd: gasCostUsd + flashloanFeeUsd,
  };
}

// ============================================
// TRIANGULAR ARBITRAGE (optimized)
// ============================================

// Only high-liquidity pairs for speed
const TRIANGULAR_TOKENS = [
  TOKENS.WETH,
  TOKENS.WBTC,
  TOKENS.WMATIC,
  TOKENS.USDC,
  TOKENS.USDT,
];

async function findTriangularArbitrage(
  amountUsd: number,
  nativePriceUsd: number
): Promise<ArbitrageResult | null> {
  const costs = await simulateFlashloanArbitrage(amountUsd, nativePriceUsd);
  const failedPairs = new Set<string>();
  const startUsd = amountUsd;

  // We'll try up to 20 paths and stop early if we find a profitable one.
  const candidates: { result: ArbitrageResult; netProfit: number }[] = [];

  for (let i = 0; i < TRIANGULAR_TOKENS.length; i++) {
    for (let j = 0; j < TRIANGULAR_TOKENS.length; j++) {
      for (let k = 0; k < TRIANGULAR_TOKENS.length; k++) {
        if (i === j || j === k || i === k) continue;
        const tokenA = TRIANGULAR_TOKENS[i];
        const tokenB = TRIANGULAR_TOKENS[j];
        const tokenC = TRIANGULAR_TOKENS[k];
        // Must end with USDC to get profit in USD
        if (tokenC.address !== TOKENS.USDC.address) continue;

        const pathKey = `${tokenA.symbol}-${tokenB.symbol}-${tokenC.symbol}`;
        if (failedPairs.has(pathKey)) continue;

        try {
          const amountInA = ethers.utils.parseUnits(
            amountUsd.toString(),
            tokenA.decimals
          ).toString();

          // Use cached quotes
          const quoteA = await getCachedQuote(TOKENS.USDC, tokenA, amountInA);
          if (!quoteA) { failedPairs.add(pathKey); continue; }

          const quoteB = await getCachedQuote(tokenA, tokenB, quoteA.amountOut);
          if (!quoteB) { failedPairs.add(pathKey); continue; }

          const quoteC = await getCachedQuote(tokenB, tokenC, quoteB.amountOut);
          if (!quoteC) { failedPairs.add(pathKey); continue; }

          // Profit calculation using Enso's price field (tokenOut per tokenIn)
          // price1: USDC -> tokenA, price2: tokenA -> tokenB, price3: tokenB -> USDC
          const price1 = quoteA.price; // tokenA per USDC
          const price2 = quoteB.price; // tokenB per tokenA
          const price3 = quoteC.price; // USDC per tokenB
          const endUsd = startUsd * price1 * price2 * price3;
          const grossProfitUsd = endUsd - startUsd;

          if (grossProfitUsd <= 0.01) continue;

          const netProfitUsd = grossProfitUsd - costs.totalCostUsd;

          if (netProfitUsd > 0.01) {
            log.info(`🔍 Triangular: ${TOKENS.USDC.symbol} → ${tokenA.symbol} → ${tokenB.symbol} → ${tokenC.symbol}`, {
              amountUsd,
              startUsd: startUsd.toFixed(4),
              endUsd: endUsd.toFixed(4),
              grossProfitUsd: grossProfitUsd.toFixed(4),
              gasCostUsd: costs.gasCostUsd.toFixed(4),
              flashloanFeeUsd: costs.flashloanFeeUsd.toFixed(4),
              netProfitUsd: netProfitUsd.toFixed(4),
            });
          }

          if (netProfitUsd > 0.05) {
            // Found a profitable path; return immediately to save time
            return {
              type: 'triangular',
              tokenPath: [TOKENS.USDC.symbol, tokenA.symbol, tokenB.symbol, tokenC.symbol],
              startUsd,
              endUsd,
              grossProfitUsd,
              gasCostUsd: costs.gasCostUsd,
              flashloanFeeUsd: costs.flashloanFeeUsd,
              netProfitUsd,
              details: { quoteA, quoteB, quoteC },
            };
          }
        } catch (err) {
          failedPairs.add(pathKey);
        }
      }
    }
  }

  return null;
}

// ============================================
// CROSS-DEX ARBITRAGE (optimized)
// ============================================

// Only high-liquidity pairs and limit venues
const CROSS_PAIRS = [
  { tokenA: TOKENS.USDC, tokenB: TOKENS.WETH },
  { tokenA: TOKENS.USDC, tokenB: TOKENS.WBTC },
  { tokenA: TOKENS.USDC, tokenB: TOKENS.WMATIC },
  { tokenA: TOKENS.WETH, tokenB: TOKENS.WBTC },
];

async function findCrossDexArbitrage(
  amountUsd: number,
  nativePriceUsd: number
): Promise<ArbitrageResult | null> {
  const costs = await simulateFlashloanArbitrage(amountUsd, nativePriceUsd);

  for (const pair of CROSS_PAIRS) {
    try {
      const amountIn = ethers.utils.parseUnits(
        amountUsd.toString(),
        pair.tokenA.decimals
      ).toString();

      await rateLimit(); // rate limit for getAllVenueQuotes
      const buyQuotes = await getAllVenueQuotes(
        pair.tokenA,
        pair.tokenB,
        amountIn
      );

      if (buyQuotes.length < 2) continue;

      const bestBuy = buyQuotes.reduce((a, b) =>
        Number(a.amountOut) > Number(b.amountOut) ? a : b
      );

      await rateLimit();
      const sellQuotes = await getAllVenueQuotes(
        pair.tokenB,
        pair.tokenA,
        bestBuy.amountOut
      );

      if (sellQuotes.length < 1) continue;

      const spread = findBestVenueSpread(
        `${pair.tokenA.symbol}-${pair.tokenB.symbol}`,
        buyQuotes,
        sellQuotes
      );

      if (!spread || spread.spreadBps < 15) continue; // minimum 15 bps

      const grossProfitUsd = amountUsd * (spread.spreadBps / 10000);
      const netProfitUsd = grossProfitUsd - costs.totalCostUsd;

      if (netProfitUsd > 0.01) {
        log.info(`🔍 Cross-DEX: ${pair.tokenA.symbol} → ${pair.tokenB.symbol}`, {
          amountUsd,
          buyVenue: spread.buyVenue,
          sellVenue: spread.sellVenue,
          spreadBps: spread.spreadBps.toFixed(2),
          grossProfitUsd: grossProfitUsd.toFixed(4),
          gasCostUsd: costs.gasCostUsd.toFixed(4),
          flashloanFeeUsd: costs.flashloanFeeUsd.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(4),
        });
      }

      if (netProfitUsd > 0.05) {
        return {
          type: 'crossdex',
          tokenPath: [pair.tokenA.symbol, pair.tokenB.symbol],
          startUsd: amountUsd,
          endUsd: amountUsd + grossProfitUsd,
          grossProfitUsd,
          gasCostUsd: costs.gasCostUsd,
          flashloanFeeUsd: costs.flashloanFeeUsd,
          netProfitUsd,
          details: { spread, buyQuotes, sellQuotes },
        };
      }
    } catch (err) {
      // Skip errors
    }
  }

  return null;
}

// ============================================
// MAIN DISCOVERY FUNCTION
// ============================================

export async function discoverArbitrage(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  log.info('🔍 Starting arbitrage discovery...', { nativePrice: nativePriceUsd });

  // Clear cache at start of scan
  quoteCache.clear();

  // Test only two amounts to save time (larger ones more likely profitable)
  const testAmounts = [25000, 50000];

  for (const amount of testAmounts) {
    log.info(`📊 Testing with $${amount} flashloan...`);

    // 1. Triangular arbitrage (fast check, returns first profitable)
    const triangular = await findTriangularArbitrage(amount, nativePriceUsd);
    if (triangular) {
      const candidate = createCandidate(triangular, nativePriceUsd);
      pushCandidate(candidate);
      candidates.push(candidate);
    }

    // 2. Cross-DEX arbitrage (slower but still limited)
    const crossdex = await findCrossDexArbitrage(amount, nativePriceUsd);
    if (crossdex) {
      const candidate = createCandidate(crossdex, nativePriceUsd);
      pushCandidate(candidate);
      candidates.push(candidate);
    }
  }

  log.info('📊 Arbitrage discovery summary:', {
    totalCandidates: candidates.length,
    byAmount: testAmounts.map(amount => ({
      amount,
      found: candidates.filter(c =>
        c.params.amountUsd === amount
      ).length,
    })),
  });

  return candidates;
}

// ============================================
// HELPER: Create Candidate
// ============================================

function createCandidate(result: ArbitrageResult, nativePriceUsd: number): OpportunityCandidate {
  const type = result.type === 'triangular' ? 'triangular' : 'crossdex';
  const path = result.tokenPath.join(' → ');

  return {
    id: `${type}-${path}-${Date.now()}`,
    strategy: 'arbitrage',
    protocol: 'enso',
    params: {
      type: result.type,
      tokenPath: result.tokenPath,
      amountUsd: result.startUsd,
      startUsd: result.startUsd,
      endUsd: result.endUsd,
      grossProfitUsd: result.grossProfitUsd,
      gasCostUsd: result.gasCostUsd,
      flashloanFeeUsd: result.flashloanFeeUsd,
      netProfitUsd: result.netProfitUsd,
      nativePriceUsd,
      details: result.details,
    },
    estimatedGrossProfitUsd: result.grossProfitUsd,
    estimatedNetProfitUsd: result.netProfitUsd,
    estimatedCostUsd: result.gasCostUsd + result.flashloanFeeUsd,
    actionPlan: null,
    sourceTimestamp: Date.now(),
  };
}