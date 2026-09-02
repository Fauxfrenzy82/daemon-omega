// src/strategies/arbitrage/discover.ts
import { ethers } from 'ethers';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { TOKENS } from '../../config/tokens';

const log = createLogger('arbitrage');

// ---------- Rate limiting ----------
let lastRequestTime = 0;
const MIN_INTERVAL = env.ARBITRAGE_RATE_LIMIT_MS || 150;

async function rateLimit() {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastRequestTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
}

// ---------- Cache ----------
const cache = new Map<string, any>();
const CACHE_TTL = 60000;

function getKey(a: string, b: string, amt: string) {
  return `${a}-${b}-${amt}`;
}

async function cachedQuote(tin: any, tout: any, amt: string) {
  const key = getKey(tin.address, tout.address, amt);
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  await rateLimit();
  try {
    const q = await getEnsoRouteQuote(tin, tout, amt);
    cache.set(key, { data: q, ts: Date.now() });
    return q;
  } catch {
    cache.set(key, { data: null, ts: Date.now() });
    return null;
  }
}

// ---------- Triangular paths ----------
const TOKENS_FOR_TRI = [
  TOKENS.WETH,
  TOKENS.WBTC,
  TOKENS.WMATIC,
  TOKENS.USDT,
];

async function findTriangular(amountUsd: number, nativePrice: number) {
  const start = amountUsd;
  const gasPrice = await provider.getGasPrice();
  const gasUnits = 300000;
  const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasUnits)));
  const gasCostUsd = gasCostNative * nativePrice;
  const flashloanFeeUsd = 0; // Morpho Blue = 0%

  for (let i = 0; i < TOKENS_FOR_TRI.length; i++) {
    for (let j = 0; j < TOKENS_FOR_TRI.length; j++) {
      if (i === j) continue;
      const A = TOKENS_FOR_TRI[i];
      const B = TOKENS_FOR_TRI[j];
      if (A.address === TOKENS.USDC.address || B.address === TOKENS.USDC.address) continue;
      const amtA = ethers.utils.parseUnits(start.toString(), A.decimals).toString();
      const q1 = await cachedQuote(TOKENS.USDC, A, amtA);
      if (!q1) continue;
      const q2 = await cachedQuote(A, B, q1.amountOut);
      if (!q2) continue;
      const q3 = await cachedQuote(B, TOKENS.USDC, q2.amountOut);
      if (!q3) continue;
      const end = start * q1.price * q2.price * q3.price;
      const gross = end - start;
      const net = gross - gasCostUsd - flashloanFeeUsd;
      log.info(`Tri: USDC→${A.symbol}→${B.symbol}→USDC`, {
        amountUsd,
        start,
        end,
        gross: gross.toFixed(4),
        gas: gasCostUsd.toFixed(4),
        fee: flashloanFeeUsd.toFixed(4),
        net: net.toFixed(4),
      });
      if (net > (env.ARBITRAGE_MIN_PROFIT_USD || 0.5)) {
        return {
          type: 'triangular',
          tokenPath: ['USDC', A.symbol, B.symbol, 'USDC'],
          startUsd: start,
          endUsd: end,
          grossProfitUsd: gross,
          gasCostUsd,
          flashloanFeeUsd,
          netProfitUsd: net,
          details: { q1, q2, q3 },
        };
      }
    }
  }
  return null;
}

// ---------- Main discovery ----------
export async function discoverArbitrage(nativePrice: number) {
  const candidates: OpportunityCandidate[] = [];
  cache.clear();

  // ✅ All amounts to test (including tiny ones)
  const amounts = [
    25000, 50000, 100000, 250000,
    300, 200, 100, 90, 70, 50, 30, 10
  ];

  for (const amount of amounts) {
    const result = await findTriangular(amount, nativePrice);
    if (result) {
      const candidate = createCandidate(result, nativePrice);
      pushCandidate(candidate);
      candidates.push(candidate);
      // Stop after first profitable candidate (adjustable)
      break;
    }
  }

  log.info('Arbitrage scan complete', { totalCandidates: candidates.length });
  return candidates;
}

function createCandidate(res: any, np: number): OpportunityCandidate {
  return {
    id: `tri-${res.tokenPath.join('-')}-${Date.now()}`,
    strategy: 'arbitrage',
    protocol: 'enso',
    params: {
      ...res,
      nativePriceUsd: np,
    },
    estimatedGrossProfitUsd: res.grossProfitUsd,
    estimatedNetProfitUsd: res.netProfitUsd,
    estimatedCostUsd: res.gasCostUsd + res.flashloanFeeUsd,
    actionPlan: null,
    sourceTimestamp: Date.now(),
  };
}