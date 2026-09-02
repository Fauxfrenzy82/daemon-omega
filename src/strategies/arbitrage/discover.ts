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
// RATE LIMITING
// ============================================

// Simple rate limiter for Enso API (10 requests per second)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 120; // ~8.3 requests per second (under 10)

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
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
  const gasUnits = ethers.BigNumber.from(600000);
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
  const tokens = [
    TOKENS.WETH,
    TOKENS.WBTC,
    TOKENS.WMATIC,
    TOKENS.USDC,
    TOKENS.USDT,
    TOKENS.DAI,
  ];

  const costs = await simulateFlashloanArbitrage(amountUsd, nativePriceUsd);

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      for (let k = 0; k < tokens.length; k++) {
        if (i === j || j === k || i === k) continue;

        const tokenA = tokens[i];
        const tokenB = tokens[j];
        const tokenC = tokens[k];

        try {
          if (tokenA.address === tokenC.address) continue;

          // Rate limit before each Enso call
          await rateLimit();
          const amountInA = ethers.utils.parseUnits(
            amountUsd.toString(),
            tokenA.decimals
          ).toString();
          const quoteA = await getEnsoRouteQuote(TOKENS.USDC, tokenA, amountInA);
          if (!quoteA) continue;

          await rateLimit();
          const quoteB = await getEnsoRouteQuote(tokenA, tokenB, quoteA.amountOut);
          if (!quoteB) continue;

          await rateLimit();
          const quoteC = await getEnsoRouteQuote(tokenB, tokenC, quoteB.amountOut);
          if (!quoteC) continue;

          const startUsd = amountUsd;
          const endUsd = Number(quoteC.amountOut) / 10 ** tokenC.decimals;
          const grossProfitUsd = endUsd - startUsd;
          if (grossProfitUsd <= 0) continue;

          const netProfitUsd = grossProfitUsd - costs.totalCostUsd;

          if (netProfitUsd > 0.01) {
            log.info(`🔍 Triangular: ${TOKENS.USDC.symbol} → ${tokenA.symbol} → ${tokenB.symbol} → ${tokenC.symbol}`, {
              amountUsd,
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
          // Skip errors
        }
      }
    }
  }

  return null;
}

// ============================================
// CROSS-DEX ARBITRAGE (with limited venues)
// ============================================

async function findCrossDexArbitrage(
  amountUsd: number,
  nativePriceUsd: number
): Promise<ArbitrageResult | null> {
  // Use only the most reliable venues to reduce API calls
  const tokenPairs = [
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WETH },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WBTC },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WMATIC },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.USDT },
    { tokenA: TOKENS.WETH, tokenB: TOKENS.WBTC },
  ];

  const costs = await simulateFlashloanArbitrage(amountUsd, nativePriceUsd);

  for (const pair of tokenPairs) {
    try {
      const amountIn = ethers.utils.parseUnits(
        amountUsd.toString(),
        pair.tokenA.decimals
      ).toString();

      // Rate limit before each venue fetch
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

      // Rate limit before sell quotes
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

      if (!spread || spread.spreadBps < 5) continue;

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

  // Test different flashloan amounts
  const testAmounts = [500, 1000, 10000, 25000];

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

  // Log summary
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