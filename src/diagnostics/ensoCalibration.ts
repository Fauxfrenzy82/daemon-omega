// src/diagnostics/ensoCalibration.ts
//
// One-off falsification test for the cross-venue assumptions this system makes
// about Enso. It trades nothing. Run it by setting ENSO_CALIBRATION=true.
// (Tip: also set STRATEGY_ARBITRAGE_ENABLED=false while it runs so the scanner
// does not compete for the 1 request/second budget. ~65 requests, ~75 seconds.)

import { TOKENS, TokenInfo } from '../config/tokens';
import { activeChain } from '../config/chains';
import { getEnsoClient } from '../execution/ensoClient';
import { executionWallet } from '../treasury/wallets';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('ensoCalibration');

const MORPHO_BLUE = '0x6c247b1F6182318877311737BaC0844bAa518F5e';
const ASSUMED_GAS_UNITS = 350000; // hard-coded in strategies/arbitrage/discover.ts

const AGGREGATORS = [
  '0x', '1inch', 'openocean', 'kyberswap', 'native', 'paraswap', 'bebop',
  'barter', 'sushiswap-router', 'ooga-booga', 'renegade', 'uniswap', 'rooster',
  'wowmax', 'grapher', 'hyperbloom', 'hyperswap', 'hyperflow', 'fly', 'eisen',
  'nordstern', 'everlong', 'bitget',
];

interface Quote {
  out: number;
  outStr: string;
  gas: number;
  hops: string[];
  keys: string[];
}

const NOT_FOUND = { notFound: true };

async function quote(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  ignoreAggregators: string[],
  label: string
): Promise<Quote | null> {
  const wallet = executionWallet.address;
  try {
    const r: any = await withRetry(
      async () => {
        try {
          return await getEnsoClient().getRouteData({
            fromAddress: wallet,
            receiver: wallet,
            spender: wallet,
            chainId: activeChain.chainId,
            amountIn: [amountIn],
            tokenIn: [tokenIn.address],
            tokenOut: [tokenOut.address],
            slippage: '100',
            routingStrategy: 'router',
            ignoreAggregators,
          });
        } catch (err: any) {
          if (err?.response?.status === 404) return NOT_FOUND;
          throw err;
        }
      },
      { label, shouldRetry: isTransientError, retries: 2 }
    );
    if (r === NOT_FOUND) return null;

    const out = Number(r?.amountOut);
    if (!isFinite(out) || out <= 0) return null;

    return {
      out,
      outStr: String(r.amountOut),
      gas: Number(r?.gas) || 0,
      hops: (Array.isArray(r?.route) ? r.route : []).map((h: any) => `${h?.protocol}/${h?.action}`),
      keys: Object.keys(r ?? {}),
    };
  } catch {
    return null;
  }
}

const bps = (value: number, base: number) => ((value - base) / base) * 10000;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (x: number) => Math.round(x * 100) / 100;

export async function runEnsoCalibration(): Promise<void> {
  const A = TOKENS.USDC;
  const B = TOKENS.WETH;
  const amt = '500000000'; // 500 USDC
  const amtNum = 500e6;

  log.info('CALIBRATION started: USDC<->WETH at $500, no trades (about 65 Enso requests)');

  // T1: noise floor. Same request repeated. Any "edge" smaller than this is noise.
  const fwd: Quote[] = [];
  for (let i = 0; i < 4; i++) {
    const q = await quote(A, B, amt, [], 'cal.fwd');
    if (q) fwd.push(q);
  }
  if (fwd.length < 2) {
    log.warn('CALIBRATION aborted: baseline quotes failed');
    return;
  }
  const outs = fwd.map((q) => q.out);
  const noiseFloorBps = round2(((Math.max(...outs) - Math.min(...outs)) / mean(outs)) * 10000);

  // T2: same-optimizer round trip. Enso picks its best route each way.
  // If the system's premise were right this would be <= 0 (you pay fees twice).
  const sameOptimizerRoundTripBps: number[] = [];
  for (const f of fwd.slice(0, 3)) {
    const r = await quote(B, A, f.outStr, [], 'cal.rev');
    if (r) sameOptimizerRoundTripBps.push(round2(bps(r.out, amtNum)));
  }

  // T3: aggregator-as-venue test. Keep exactly ONE aggregator on at a time.
  const fwdByAgg: Array<{ agg: string; q: Quote }> = [];
  for (const a of AGGREGATORS) {
    const q = await quote(A, B, amt, AGGREGATORS.filter((x) => x !== a), `cal.fwd.${a}`);
    if (q) fwdByAgg.push({ agg: a, q });
  }

  let crossAggregatorRoundTripBps: number | null = null;
  let bestFwdAgg: string | null = null;
  let bestRevAgg: string | null = null;
  let aggDispersionBps: number | null = null;

  if (fwdByAgg.length > 0) {
    const best = fwdByAgg.reduce((a, b) => (b.q.out > a.q.out ? b : a));
    bestFwdAgg = best.agg;
    const fo = fwdByAgg.map((x) => x.q.out);
    aggDispersionBps = round2(((Math.max(...fo) - Math.min(...fo)) / mean(fo)) * 10000);

    // Best buy aggregator, then the best SELL aggregator for what we received.
    let bestRev: { agg: string; q: Quote } | null = null;
    for (const a of AGGREGATORS) {
      const r = await quote(B, A, best.q.outStr, AGGREGATORS.filter((x) => x !== a), `cal.rev.${a}`);
      if (r && (!bestRev || r.out > bestRev.q.out)) bestRev = { agg: a, q: r };
    }
    if (bestRev) {
      bestRevAgg = bestRev.agg;
      crossAggregatorRoundTripBps = round2(bps(bestRev.q.out, amtNum));
    }
  }

  // T4: does Enso's own simulator accept a plain round trip inside a flash loan?
  const a = A.address.toLowerCase();
  const b = B.address.toLowerCase();
  let simPassed = false;
  let simMessage = '';
  try {
    await getEnsoClient().getBundleData(
      { fromAddress: executionWallet.address, chainId: activeChain.chainId, routingStrategy: 'router' },
      [
        {
          protocol: 'morpho-markets-v1',
          action: 'flashloan',
          args: {
            flashloanToken: a,
            flashloanAmount: amt,
            callback: [
              { protocol: 'enso', action: 'route', args: { tokenIn: a, tokenOut: b, amountIn: amt, slippage: '100' } },
              { protocol: 'enso', action: 'route', args: { tokenIn: b, tokenOut: a, amountIn: { useOutputOfCallAt: 0 }, slippage: '100' } },
            ],
            primaryAddress: MORPHO_BLUE.toLowerCase(),
          },
        },
      ]
    );
    simPassed = true;
  } catch (err: any) {
    simMessage = String(err?.response?.data?.message ?? err?.message ?? err).slice(0, 200);
  }

  const report = {
    pair: 'USDC<->WETH',
    sizeUsd: 500,
    noiseFloorBps,
    sameOptimizerRoundTripBps,
    aggregatorsQuoting: fwdByAgg.map((x) => x.agg),
    aggregatorDispersionBps: aggDispersionBps,
    bestBuyAggregator: bestFwdAgg,
    bestSellAggregator: bestRevAgg,
    crossAggregatorRoundTripBps,
    routeGasUnitsSeen: fwd[0].gas,
    assumedGasUnits: ASSUMED_GAS_UNITS,
    flashLoanRoundTripSimulation: simPassed ? 'PASSED' : `FAILED: ${simMessage}`,
    baselineHops: fwd[0].hops,
    responseFields: fwd[0].keys,
  };
  log.info('CALIBRATION REPORT', report);

  // Plain-language verdicts
  const verdicts: string[] = [];
  if (crossAggregatorRoundTripBps === null) {
    verdicts.push('Could not test cross-aggregator trading (no single aggregator returned a quote).');
  } else if (crossAggregatorRoundTripBps <= 0) {
    verdicts.push(`NO CROSS-AGGREGATOR EDGE: best buy + best sell still returns ${crossAggregatorRoundTripBps} bps. Buying on one Enso aggregator and selling on another loses money.`);
  } else if (crossAggregatorRoundTripBps <= noiseFloorBps) {
    verdicts.push(`Cross-aggregator round trip (+${crossAggregatorRoundTripBps} bps) is inside the noise floor (${noiseFloorBps} bps): not a real edge.`);
  } else {
    verdicts.push(`Cross-aggregator round trip +${crossAggregatorRoundTripBps} bps is above noise (${noiseFloorBps} bps): worth validating with the simulator.`);
  }
  if (sameOptimizerRoundTripBps.some((x) => x > 0)) {
    verdicts.push('Same-optimizer round trip was POSITIVE: Enso quotes are not firm prices (a true round trip cannot profit).');
  }
  verdicts.push(simPassed
    ? 'Enso simulator accepted the round trip.'
    : 'Enso simulator REJECTED the round trip: quoted amounts are not executable.');
  if (fwd[0].gas > ASSUMED_GAS_UNITS) {
    verdicts.push(`Gas model is too low: Enso reports ${fwd[0].gas} gas units, the scanner assumes ${ASSUMED_GAS_UNITS}.`);
  }
  verdicts.forEach((v) => log.info(`CALIBRATION VERDICT: ${v}`));
}