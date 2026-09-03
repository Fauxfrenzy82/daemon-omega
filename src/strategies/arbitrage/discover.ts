// src/strategies/arbitrage/discover.ts
import { ethers } from 'ethers';
import { provider, executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { getAllVenueQuotes, findBestVenueSpread } from '../../scanner/sources/ensoMultiVenue';
import { TOKENS, TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { RateLimiter } from '../../utils/rateLimiter';

const log = createLogger('arbitrage');

// ============================================
// RATE LIMITING
// ============================================

const ensoLimiter = new RateLimiter(8, 1000, 'enso-arbitrage');

// ============================================
// CACHE
// ============================================

const cache = new Map<string, any>();
const CACHE_TTL = 60000;

function getKey(a: string, b: string, amt: string) {
  return `${a}-${b}-${amt}`;
}

async function cachedVenueQuotes(tokenA: TokenInfo, tokenB: TokenInfo, amount: string) {
  const key = getKey(tokenA.address, tokenB.address, amount);
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  
  await ensoLimiter.acquire();
  
  try {
    const quotes = await getAllVenueQuotes(tokenA, tokenB, amount);
    cache.set(key, { data: quotes, ts: Date.now() });
    return quotes;
  } catch {
    return [];
  }
}

// ============================================
// TOKEN PAIRS
// ============================================

const CROSS_PAIRS = [
  { tokenA: TOKENS.USDC, tokenB: TOKENS.WETH },
  { tokenA: TOKENS.USDC, tokenB: TOKENS.WBTC },
  { tokenA: TOKENS.USDC, tokenB: TOKENS.WMATIC },
  { tokenA: TOKENS.WETH, tokenB: TOKENS.WBTC },
];

// ============================================
// TEST AMOUNTS: 10, 50, 500, 1000
// ============================================

const TEST_AMOUNTS = [10, 50, 500, 1000];

// ============================================
// MAIN DISCOVERY
// ============================================

export async function discoverArbitrage(nativePrice: number) {
  const candidates: OpportunityCandidate[] = [];
  cache.clear();

  const results: {
    amount: number;
    pair: string;
    spreadBps: number;
    grossProfit: number;
    gasCost: number;
    netProfit: number;
    buyVenue: string;
    sellVenue: string;
    profitable: boolean;
  }[] = [];

  const gasPrice = await provider.getGasPrice();
  const gasUnits = 350000;
  const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasUnits)));
  const gasCostUsd = gasCostNative * nativePrice;

  log.info('🔍 Starting Cross-DEX arbitrage discovery...', { nativePrice });

  for (const amount of TEST_AMOUNTS) {
    log.info(`📊 Testing with $${amount}...`);

    for (const pair of CROSS_PAIRS) {
      try {
        const amountIn = ethers.utils.parseUnits(
          amount.toString(),
          pair.tokenA.decimals
        ).toString();

        // Get buy quotes (tokenA → tokenB)
        const buyQuotes = await cachedVenueQuotes(pair.tokenA, pair.tokenB, amountIn);
        if (buyQuotes.length < 2) continue;

        // Best buy (most output)
        const bestBuy = buyQuotes.reduce((a, b) =>
          Number(a.amountOut) > Number(b.amountOut) ? a : b
        );

        // Get sell quotes (tokenB → tokenA)
        const sellQuotes = await cachedVenueQuotes(pair.tokenB, pair.tokenA, bestBuy.amountOut);
        if (sellQuotes.length < 1) continue;

        // Find best spread
        const spread = findBestVenueSpread(
          `${pair.tokenA.symbol}-${pair.tokenB.symbol}`,
          buyQuotes,
          sellQuotes
        );

        if (!spread || spread.spreadBps < 1) continue;

        // Calculate profit
        const grossProfitUsd = amount * (spread.spreadBps / 10000);
        const netProfitUsd = grossProfitUsd - gasCostUsd;

        results.push({
          amount,
          pair: `${pair.tokenA.symbol}→${pair.tokenB.symbol}`,
          spreadBps: spread.spreadBps,
          grossProfit: grossProfitUsd,
          gasCost: gasCostUsd,
          netProfit: netProfitUsd,
          buyVenue: spread.buyVenue,
          sellVenue: spread.sellVenue,
          profitable: netProfitUsd > 0,
        });

        log.info(`🔍 Cross-DEX: ${pair.tokenA.symbol}→${pair.tokenB.symbol}`, {
          amount,
          spreadBps: spread.spreadBps.toFixed(2),
          buyVenue: spread.buyVenue,
          sellVenue: spread.sellVenue,
          grossProfitUsd: grossProfitUsd.toFixed(4),
          gasCostUsd: gasCostUsd.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(4),
          profitable: netProfitUsd > 0,
        });

        if (netProfitUsd > 0.01) {
          const candidate: OpportunityCandidate = {
            id: `crossdex-${pair.tokenA.symbol}-${pair.tokenB.symbol}-${Date.now()}`,
            strategy: 'arbitrage',
            protocol: 'enso',
            params: {
              type: 'crossdex',
              pair: `${pair.tokenA.symbol}-${pair.tokenB.symbol}`,
              tokenA: pair.tokenA,
              tokenB: pair.tokenB,
              amountUsd: amount,
              startUsd: amount,
              endUsd: amount + grossProfitUsd,
              spreadBps: spread.spreadBps,
              grossProfitUsd,
              gasCostUsd,
              netProfitUsd,
              buyVenue: spread.buyVenue,
              sellVenue: spread.sellVenue,
              buyQuote: spread.buyQuote,
              sellQuote: spread.sellQuote,
              nativePrice,
            },
            estimatedGrossProfitUsd: grossProfitUsd,
            estimatedNetProfitUsd: netProfitUsd,
            estimatedCostUsd: gasCostUsd,
            actionPlan: null,
            sourceTimestamp: Date.now(),
          };
          pushCandidate(candidate);
          candidates.push(candidate);
        }
      } catch (err) {
        // Skip errors
      }
    }
  }

  // ============================================
  // SUMMARY STATISTICS
  // ============================================

  const profitable = results.filter(r => r.profitable);
  const totalProfitable = profitable.length;
  const totalResults = results.length;

  const avgSpread = totalResults > 0 ? results.reduce((s, r) => s + r.spreadBps, 0) / totalResults : 0;
  const avgGross = totalResults > 0 ? results.reduce((s, r) => s + r.grossProfit, 0) / totalResults : 0;
  const avgNet = totalResults > 0 ? results.reduce((s, r) => s + r.netProfit, 0) / totalResults : 0;
  const avgNetProfitable = totalProfitable > 0 
    ? profitable.reduce((s, r) => s + r.netProfit, 0) / totalProfitable 
    : 0;

  // Group by amount
  const byAmount = TEST_AMOUNTS.map(amt => {
    const amtResults = results.filter(r => r.amount === amt);
    const amtProfitable = amtResults.filter(r => r.profitable);
    const avgNet = amtResults.length > 0 ? amtResults.reduce((s, r) => s + r.netProfit, 0) / amtResults.length : 0;
    return {
      amount: amt,
      total: amtResults.length,
      profitable: amtProfitable.length,
      avgNetProfit: avgNet,
      bestNetProfit: amtResults.length > 0 ? Math.max(...amtResults.map(r => r.netProfit)) : 0,
      worstNetProfit: amtResults.length > 0 ? Math.min(...amtResults.map(r => r.netProfit)) : 0,
    };
  });

  log.info('📊 ===== CROSS-DEX ARBITRAGE SUMMARY =====');
  log.info(`Total opportunities checked: ${totalResults}`);
  log.info(`Profitable opportunities: ${totalProfitable}`);
  log.info(`Average spread: ${avgSpread.toFixed(2)} bps`);
  log.info(`Average gross profit: $${avgGross.toFixed(4)}`);
  log.info(`Average net profit (all): $${avgNet.toFixed(4)}`);
  log.info(`Average net profit (profitable only): $${avgNetProfitable.toFixed(4)}`);

  log.info('📊 By amount:');
  for (const a of byAmount) {
    log.info(`  $${a.amount}: ${a.profitable}/${a.total} profitable, avg net $${a.avgNetProfit.toFixed(4)}, best $${a.bestNetProfit.toFixed(4)}, worst $${a.worstNetProfit.toFixed(4)}`);
  }

  log.info('📊 Top 5 best opportunities:');
  const sorted = [...results].sort((a, b) => b.netProfit - a.netProfit);
  for (const r of sorted.slice(0, 5)) {
    log.info(`  ${r.pair} @ $${r.amount}: ${r.spreadBps.toFixed(2)} bps, net $${r.netProfit.toFixed(4)} (${r.buyVenue}→${r.sellVenue})`);
  }

  if (candidates.length === 0) {
    log.info('📭 No profitable Cross-DEX arbitrage opportunities found this cycle');
  } else {
    log.info(`📦 Found ${candidates.length} profitable Cross-DEX arbitrage opportunities`);
  }

  return candidates;
}