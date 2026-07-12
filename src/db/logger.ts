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
}

export async function logOpportunity(rec: OpportunityRecord): Promise<number> {
  try {
    const result = await query<{ id: number }>(
      `INSERT INTO opportunities
       (pair_id, base_symbol, quote_symbol, source_buy, source_sell,
        price_buy, price_sell, spread_bps, est_liquidity_usd,
        est_gas_cost_usd, est_protocol_fee_usd, est_net_profit_usd, meets_threshold)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
      ]
    );
    return result.rows[0].id;
  } catch (err) {
    log.error('Failed to log opportunity', { error: err instanceof Error ? err.message : String(err) });
    return -1;
  }
}

export interface TradeRecord {
  opportunityId?: number;
  pairId: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'reverted';
  txHash?: string;
  positionSizeUsd: number;
  expectedProfitUsd: number;
  actualProfitUsd?: number;
  gasUsed?: number;
  gasCostUsd?: number;
  protocolFeeUsd?: number;
  errorMessage?: string;
}

export async function logTrade(rec: TradeRecord): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO trades
     (opportunity_id, pair_id, status, tx_hash, position_size_usd,
      expected_profit_usd, actual_profit_usd, gas_used, gas_cost_usd,
      protocol_fee_usd, error_message, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             CASE WHEN $3 IN ('submitted','confirmed','failed','reverted') THEN now() ELSE NULL END)
     RETURNING id`,
    [
      rec.opportunityId ?? null,
      rec.pairId,
      rec.status,
      rec.txHash ?? null,
      rec.positionSizeUsd,
      rec.expectedProfitUsd,
      rec.actualProfitUsd ?? null,
      rec.gasUsed ?? null,
      rec.gasCostUsd ?? null,
      rec.protocolFeeUsd ?? null,
      rec.errorMessage ?? null,
    ]
  );
  return result.rows[0].id;
}

export async function updateTradeStatus(
  tradeId: number,
  status: TradeRecord['status'],
  updates: Partial<{
    txHash: string;
    actualProfitUsd: number;
    gasUsed: number;
    gasCostUsd: number;
    errorMessage: string;
  }> = {}
): Promise<void> {
  await query(
    `UPDATE trades SET
       status = $2,
       tx_hash = COALESCE($3, tx_hash),
       actual_profit_usd = COALESCE($4, actual_profit_usd),
       gas_used = COALESCE($5, gas_used),
       gas_cost_usd = COALESCE($6, gas_cost_usd),
       error_message = COALESCE($7, error_message),
       confirmed_at = CASE WHEN $2 IN ('confirmed','failed','reverted') THEN now() ELSE confirmed_at END
     WHERE id = $1`,
    [
      tradeId,
      status,
      updates.txHash ?? null,
      updates.actualProfitUsd ?? null,
      updates.gasUsed ?? null,
      updates.gasCostUsd ?? null,
      updates.errorMessage ?? null,
    ]
  );
}

export interface SweepRecord {
  tokenSymbol: string;
  amount: number;
  amountUsd?: number;
  fromAddress: string;
  toAddress: string;
  txHash?: string;
  status: 'pending' | 'confirmed' | 'failed';
  errorMessage?: string;
}

export async function logSweep(rec: SweepRecord): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO sweeps
     (token_symbol, amount, amount_usd, from_address, to_address, tx_hash, status, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      rec.tokenSymbol,
      rec.amount,
      rec.amountUsd ?? null,
      rec.fromAddress,
      rec.toAddress,
      rec.txHash ?? null,
      rec.status,
      rec.errorMessage ?? null,
    ]
  );
  return result.rows[0].id;
}

export async function updateSweepStatus(
  sweepId: number,
  status: SweepRecord['status'],
  txHash?: string,
  errorMessage?: string
): Promise<void> {
  await query(
    `UPDATE sweeps SET
       status = $2,
       tx_hash = COALESCE($3, tx_hash),
       error_message = COALESCE($4, error_message),
       confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END
     WHERE id = $1`,
    [sweepId, status, txHash ?? null, errorMessage ?? null]
  );
}

export async function logCircuitBreakerEvent(
  eventType: 'tripped' | 'reset',
  reason: string
): Promise<void> {
  await query(
    `INSERT INTO circuit_breaker_events (event_type, reason) VALUES ($1, $2)`,
    [eventType, reason]
  );
}

export async function getRecentTradeOutcomes(limit: number): Promise<{ status: string }[]> {
  const result = await query<{ status: string }>(
    `SELECT status FROM trades
     WHERE status IN ('confirmed','failed','reverted')
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}