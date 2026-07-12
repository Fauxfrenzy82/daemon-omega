import { QuoteResult } from './priceSource';
import { createLogger } from '../utils/logger';

const log = createLogger('liquidityCheck');

export interface LiquidityAssessment {
  sufficient: boolean;
  estSlippageBps: number;
  reason?: string;
}

export function assessSlippage(
  smallQuote: QuoteResult,
  fullQuote: QuoteResult,
  maxSlippageBps: number
): LiquidityAssessment {
  if (smallQuote.price <= 0 || fullQuote.price <= 0) {
    return { sufficient: false, estSlippageBps: Infinity, reason: 'invalid price data' };
  }

  const priceImpact = Math.abs((smallQuote.price - fullQuote.price) / smallQuote.price);
  const impactBps = priceImpact * 10000;
  const sufficient = impactBps <= maxSlippageBps;

  if (!sufficient) {
    log.debug('Slippage exceeds threshold', {
      source: fullQuote.source,
      impactBps,
      maxSlippageBps,
    });
  }

  return {
    sufficient,
    estSlippageBps: impactBps,
  };
}

export function meetsLiquidityFloor(
  quote: QuoteResult,
  minLiquidityUsd: number
): boolean {
  if (quote.estLiquidityUsd === undefined) {
    return true;
  }
  return quote.estLiquidityUsd >= minLiquidityUsd;
}