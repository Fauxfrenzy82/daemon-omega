// Existing file, we'll modify the OpportunityRecord interface and the SQL insert.
// Provide new full file content.

import { query } from './client';
import { createLogger } from '../utils/logger';

const log = createLogger('db-logger');

export interface OpportunityRecord {
  pairId: string;
  baseSymbol: string;
  quoteSymbol: string;
  sourceBuy: string;
  sourceSell: string;
  priceBuy: number;
  priceSell: number;
  spreadBps: number;
  estLiquidityUsd?: number;
  estGasCostUsd?: number;
  estProtocolFeeUsd?: number;
  estNetProfitUsd: number;
  meetsThreshold: boolean;
  strategy?: string;
  strategyMetadata?: any;
}

export async function logOpportunity(rec: OpportunityRecord): Promise<number> {
  try {
    const result = await query<{ id: number }>(
      `INSERT INTO opportunities
       (pair_id, base_symbol, quote_symbol, source_buy, source_sell,
        price_buy, price_sell, spread_bps, est_liquidity_usd,
        est_gas_cost_usd, est_protocol_fee_usd, est_net_profit_usd, meets_threshold,
        strategy, strategy_metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        rec.pairId,
        rec.baseSymbol,
        rec.quoteSymbol,
        rec.sourceBuy,
        rec.sourceSell,
        rec.priceBuy,
        rec.priceSell,
        rec.spreadBps,
        rec.estLiquidityUsd ?? null,
        rec.estGasCostUsd ?? null,
        rec.estProtocolFeeUsd ?? null,
        rec.estNetProfitUsd,
        rec.meetsThreshold,
        rec.strategy ?? null,
        rec.strategyMetadata ? JSON.stringify(rec.strategyMetadata) : null,
      ]
    );
    return result.rows[0].id;
  } catch (err) {
    log.error('Failed to log opportunity', { error: err instanceof Error ? err.message : String(err) });
    return -1;
  }
}

// The rest of the file (logTrade, updateTradeStatus, etc.) remains unchanged.
// We'll just provide the full file content here, but keep the existing functions.
// Since the user might have the original, we can note changes.