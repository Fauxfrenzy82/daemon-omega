// src/strategies/arbitrage/discover.ts

import { ethers } from 'ethers';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider, executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { getAllDirectVenueQuotes, findBestVenueSpread } from '../../scanner/sources/ensoMultiVenue';
import { TOKENS, TokenInfo } from '../../config/tokens';

const log = createLogger('arbitrage');

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
  morphoFeeBps: number = 0 // Morpho = 0% fee
): Promise<{
  gasCostUsd: number;
  flashloanFeeUsd: number;
  totalCostUsd: number;
}> {
  // Estimate gas for flashloan + swaps (typically higher for arbitrage)
  const gasPrice = await provider.getGasPrice();
  const gasUnits = ethers.BigNumber.from(600000); // 600k gas for complex arbitrage
  const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasUnits)));
  const gasCostUsd = gasCostNative * nativePriceUsd;

  // Flashloan fee (Morpho = 0%)
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

  // Pre-calculate flashloan costs
  const costs = await simulateFlashloanArbitrage(amountUsd, nativePriceUsd);

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      for (let k = 0; k < tokens.length; k++) {
        if (i === j || j === k || i === k) continue;

        const tokenA = tokens[i];
        const tokenB = tokens[j];
        const tokenC = tokens[k];

        try {
          // Skip if any token is the same as the entry token
          if (tokenA.address === tokenC.address) continue;

          // Step 1: USDC → TokenA
          const amountInA = ethers.utils.parseUnits(
            amountUsd.toString(),
            tokenA.decimals
          ).toString();

          const quoteA = await getEnsoRouteQuote(TOKENS.USDC, tokenA, amountInA);
          if (!quoteA) continue;

          // Step 2: TokenA → TokenB
          const quoteB = await getEnsoRouteQuote(tokenA, tokenB, quoteA.amountOut);
          if (!quoteB) continue;

          // Step 3: TokenB → TokenC (usually USDC)
          const quoteC = await getEnsoRouteQuote(tokenB, tokenC, quoteB.amountOut);
          if (!quoteC) continue;

          // Calculate profit
          const startUsd = amountUsd;
          const endUsd = Number(quoteC.amountOut) / 10 ** tokenC.decimals;
          const grossProfitUsd = endUsd - startUsd;

          // Only consider positive gross profit
          if (grossProfitUsd <= 0) continue;

          const netProfitUsd = grossProfitUsd - costs.totalCostUsd;

          // Log significant results
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
// CROSS-DEX ARBITRAGE
// ============================================

async function findCrossDexArbitrage(
  amountUsd: number,
  nativePriceUsd: number
): Promise<ArbitrageResult | null> {
  const tokenPairs = [
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WETH },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WBTC },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.WMATIC },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.USDT },
    { tokenA: TOKENS.USDC, tokenB: TOKENS.DAI },
    { tokenA: TOKENS.WETH, tokenB: TOKENS.WBTC },
    { tokenA: TOKENS.WETH, tokenB: TOKENS.WMATIC },
    { tokenA: TOKENS.WBTC, tokenB: TOKENS.WMATIC },
  ];

  const costs = await simulateFlashloanArbitrage(amountUsd, nativePriceUsd);

  for (const pair of tokenPairs) {
    try {
      const amountIn = ethers.utils.parseUnits(
        amountUsd.toString(),
        pair.tokenA.decimals
      ).toString();

      // Get buy quotes (tokenA → tokenB)
      const buyQuotes = await getAllDirectVenueQuotes(
        pair.tokenA,
        pair.tokenB,
        amountIn
      );

      if (buyQuotes.length < 2) continue;

      // Get sell quotes (tokenB → tokenA)
      // Use the best buy quote's output as input for sell
      const bestBuy = buyQuotes.reduce((a, b) => 
        Number(a.amountOut) > Number(b.amountOut) ? a : b
      );

      const sellQuotes = await getAllDirectVenueQuotes(
        pair.tokenB,
        pair.tokenA,
        bestBuy.amountOut
      );

      if (sellQuotes.length < 1) continue;

      // Find best spread
      const spread = findBestVenueSpread(
        `${pair.tokenA.symbol}-${pair.tokenB.symbol}`,
        buyQuotes,
        sellQuotes
      );

      if (!spread || spread.spreadBps < 5) continue;

      // Calculate profit
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