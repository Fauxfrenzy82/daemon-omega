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

const quoteCache = new Map<string, any>();

function getCacheKey(tokenIn: string, tokenOut: string, amountIn: string): string {
  return `${tokenIn}-${tokenOut}-${amountIn}`;
}

async function getCachedQuote(tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: string): Promise<any> {
  const key = getCacheKey(tokenIn.address, tokenOut.address, amountIn);
  if (quoteCache.has(key)) {
    return quoteCache.get(key);
  }
  await rateLimit();
  const quote = await getEnsoRouteQuote(tokenIn, tokenOut, amountIn);
  if (quote) {
    quoteCache.set(key, quote);
  }
  return quote;
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
// FLASHLOAN SIMULATION
// ============================================

async function simulateFlashloanArbitrage(
  amountUsd: number,
  nativePriceUsd: number,
  morphoFeeBps: number = 0
): Promise<{
  gasCostUsd: number;
  flashloanFeeUsd: number;
  totalCostUsd: number;
}> {
  const gasPrice = await provider.getGasPrice();
  const gasUnits = ethers.BigNumber.from(500000);
  const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasUnits)));
  const gasCostUsd = gasCostNative * nativePriceUsd;
  const flashloanFeeUsd = amountUsd * (morphoFeeBps / 10000);
  return {
    gasCostUsd,
    flashloanFeeUsd,
    totalCostUsd: gasCostUsd + flashloanFeeUsd,
  };
}

// ============================================
// TRIANGULAR ARBITRAGE
// ============================================

async function findTriangularArbitrage(
  amountUsd: number,
  nativePriceUsd: number
): Promise<ArbitrageResult | null> {
  // ✅ Reduce token pairs to avoid excessive API calls
  const tokens = [
    TOKENS.WETH,
    TOKENS.WBTC,
    TOKENS.WMATIC,
    TOKENS.USDC,
    TOKENS.USDT,
  ];

  const costs = await simulateFlashloanArbitrage(amountUsd, nativePriceUsd);

  // Track failed pairs to avoid repeated 404s
  const failedPairs = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      for (let k = 0; k < tokens.length; k++) {
        if (i === j || j === k || i === k) continue;

        const tokenA = tokens[i];
        const tokenB = tokens[j];
        const tokenC = tokens[k];

        // Skip if USDC is not the entry or exit
        if (tokenC.address !== TOKENS.USDC.address) continue;

        const key = `${tokenA.symbol}-${tokenB.symbol}-${tokenC.symbol}`;
        if (failedPairs.has(key)) continue;

        try {
          const amountInA = ethers.utils.parseUnits(
            amountUsd.toString(),
            tokenA.decimals
          ).toString();

          // ✅ Use cached quotes
          const quoteA = await getCachedQuote(TOKENS.USDC, tokenA, amountInA);
          if (!quoteA) {
            failedPairs.add(key);
            continue;
          }

          const quoteB = await getCachedQuote(tokenA, tokenB, quoteA.amountOut);
          if (!quoteB) {
            failedPairs.add(key);
            continue;
          }

          const quoteC = await getCachedQuote(tokenB, tokenC, quoteB.amountOut);
          if (!quoteC) {
            failedPairs.add(key);
            continue;
          }

          // ✅ FIXED: Calculate profit correctly using token prices
          // Get token prices in USD
          const priceA = quoteA.price;
          const priceB = quoteB.price;
          const priceC = quoteC.price;

          // Calculate value in USD at each step
          const startValue = amountUsd;
          const midValue = Number(quoteA.amountOut) / 10 ** tokenA.decimals * priceA;
          const endValue = Number(quoteC.amountOut) / 10 ** tokenC.decimals * priceC;

          const grossProfitUsd = endValue - startValue;

          if (grossProfitUsd <= 0.01) continue;

          const netProfitUsd = grossProfitUsd - costs.totalCostUsd;

          if (netProfitUsd > 0.01) {
            log.info(`🔍 Triangular: ${TOKENS.USDC.symbol} → ${tokenA.symbol} → ${tokenB.symbol} → ${tokenC.symbol}`, {
              amountUsd,
              startValue: startValue.toFixed(4),
              midValue: midValue.toFixed(4),
              endValue: endValue.toFixed(4),
              grossProfitUsd: grossProfitUsd.toFixed(4),
              gasCostUsd: costs.gasCostUsd.toFixed(4),
              flashloanFeeUsd: costs.flashloanFeeUsd.toFixed(4),
              netProfitUsd: netProfitUsd.toFixed(4),
            });
          }

          if (netProfitUsd > 0.05) {
            return {
              type: 'triangular',
              tokenPath: [TOKENS.USDC.symbol, tokenA.symbol, tokenB.symbol, tokenC.symbol],
              startUsd: startValue,
              endUsd: endValue,
              grossProfitUsd,
              gasCostUsd: costs.gasCostUsd,
              flashloanFeeUsd: costs.flashloanFeeUsd,
              netProfitUsd,
              details: { quoteA, quoteB, quoteC },
            };
          }
        } catch (err) {
          failedPairs.add(key);
        }
      }
    }
  }

  return null;
}

// ============================================
// CROSS-DEX ARBITRAGE
// ============================================

async function findCrossDexArbitrage(
  amountUsd: number,
  nativePriceUsd: number
): Promise<ArbitrageResult | null> {
  // ✅ Only high-liquidity pairs
  const tokenPairs = [
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WETH },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WBTC },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WMATIC },
    { tokenA: TOKENS.WETH, tokenB: TOKENS.WBTC },
  ];

  const costs = await simulateFlashloanArbitrage(amountUsd, nativePriceUsd);

  for (const pair of tokenPairs) {
    try {
      const amountIn = ethers.utils.parseUnits(
        amountUsd.toString(),
        pair.tokenA.decimals
      ).toString();

      // ✅ Rate limit before venue fetch
      await rateLimit();
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

      if (!spread || spread.spreadBps < 10) continue;

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

  // ✅ Test larger amounts first (more likely to be profitable)
  const testAmounts = [10000, 25000, 50000, 100000];

  // Clear cache before each scan
  quoteCache.clear();

  for (const amount of testAmounts) {
    log.info(`📊 Testing with $${amount} flashloan...`);

    // 1. Triangular arbitrage
    const triangular = await findTriangularArbitrage(amount, nativePriceUsd);
    if (triangular) {
      const candidate = createCandidate(triangular, nativePriceUsd);
      pushCandidate(candidate);
      candidates.push(candidate);
    }

    // 2. Cross-DEX arbitrage
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