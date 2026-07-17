import { ethers } from 'ethers';
import { enabledPairs, PairConfig } from '../config/pairs';
import { TokenInfo } from '../config/tokens';
import { ensoRouteSource } from './sources/ensoRoute';
import { PriceSource, QuoteResult } from './priceSource';
import { findBestSpread } from './spreadCalculator';
import { evaluateOpportunity, EvaluatedOpportunity } from '../profitability/evaluator';
import { processOpportunityBatch } from '../execution/queue';
import { hasExecutionCapacity } from '../execution/concurrency';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';

const log = createLogger('scanLoop');

// paraswapV5Source and uniswapV3Source REMOVED, replaced with
// ensoRouteSource. Root cause: those two sources priced trades using
// independent systems (Uniswap V3's direct on-chain quoter + Velora/
// ParaSwap's separate price API) that routinely disagreed with what
// Enso's own execution engine actually delivered — by 100+ bps in
// production, on the same pair, same moment (scanner said +67 bps
// profit, Enso's real execution came back -84 bps short). Since Enso
// is what actually executes every trade, pricing with Enso's own
// /shortcuts/route endpoint (same routing engine) closes that gap by
// construction. This also removes the ParaSwap dependency entirely,
// which has separately begun hard rate-limiting (429s on every
// request) as of this session — a second, independent problem this
// same change resolves.
//
// NOTE: findBestSpread() requires at least 2 quotes per pair to
// compute a spread — with a single source, that comparison no longer
// applies the same way. See scanPair() below for the adjusted logic.
const SOURCES: PriceSource[] = [
  ensoRouteSource,
];

let cachedNativeUsdPrice = 0.5;

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  if (amountHuman <= 0) return '0';
  return ethers.utils.parseUnits(amountHuman.toString(), token.decimals).toString();
}

async function getQuotesForPair(pair: PairConfig): Promise<QuoteResult[]> {
  const positionRaw = toRawAmount(pair.maxPositionUsd, pair.quote);

  const requests = SOURCES.map((source) =>
    source.getQuote({
      tokenIn: pair.quote,
      tokenOut: pair.base,
      amountIn: positionRaw,
    }).catch((err) => {
      log.debug('Source quote threw', { source: source.name, pairId: pair.id, error: String(err) });
      return null;
    })
  );

  const results = await Promise.all(requests);
  return results.filter((r): r is QuoteResult => r !== null);
}

/**
 * With a single price source (Enso route), there is no cross-source
 * spread to compute in the old