import { query } from '../db/client';
import { createLogger } from '../utils/logger';

const log = createLogger('summary');

export interface PeriodSummary {
  periodLabel: string;
  since: Date;
  totalAttempts: number;
  confirmedTrades: number;
  failedTrades: number;
  totalActualProfitUsd: number;
  totalExpectedProfitUsd: number;
  avgProfitPerTradeUsd: number;
  bestTrade: { pairId: string; profitUsd: number; txHash: string | null } | null;
}

interface TradeRow {
  pair_id: string;
  status: string;
  actual_profit_usd: string | null;
  expected_profit_usd: string | null;
  tx_hash: string | null;
}

/**
 * Summarizes trade activity since a given timestamp. Uses actual_profit_usd
 * where available (real, measured on-chain outcome from queue.ts's balance
 * check) and falls back to expected_profit_usd only for older confirmed
 * trades that predate that measurement being added, so historical rows
 * still contribute something rather than being silently dropped.
 */
export async function getSummarySince(since: Date, periodLabel: string): Promise<PeriodSummary> {
  const result = await query<TradeRow>(
    `SELECT pair_id, status, actual_profit_usd, expected_profit_usd, tx_hash
     FROM trades
     WHERE created_at >= $1
     ORDER BY created_at ASC`,
    [since.toISOString()]
  );

  const rows = result.rows;
  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'reverted');

  let totalActualProfitUsd = 0;
  let totalExpectedProfitUsd = 0;
  let bestTrade: PeriodSummary['bestTrade'] = null;

  for (const row of confirmed) {
    const actual = row.actual_profit_usd !== null ? Number(row.actual_profit_usd) : null;
    const expected = row.expected_profit_usd !== null ? Number(row.expected_profit_usd) : 0;
    const effectiveProfit = actual !== null ? actual : expected;

    totalActualProfitUsd += effectiveProfit;
    totalExpectedProfitUsd += expected;

    if (!bestTrade || effectiveProfit > bestTrade.profitUsd) {
      bestTrade = { pairId: row.pair_id, profitUsd: effectiveProfit, txHash: row.tx_hash };
    }
  }

  const avgProfitPerTradeUsd = confirmed.length > 0 ? totalActualProfitUsd / confirmed.length : 0;

  const summary: PeriodSummary = {
    periodLabel,
    since,
    totalAttempts: rows.length,
    confirmedTrades: confirmed.length,
    failedTrades: failed.length,
    totalActualProfitUsd,
    totalExpectedProfitUsd,
    avgProfitPerTradeUsd,
    bestTrade,
  };

  log.debug('Generated period summary', summary);
  return summary;
}

export async function getHourlySummary(): Promise<PeriodSummary> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  return getSummarySince(since, 'Last Hour');
}

export async function getDailySummary(): Promise<PeriodSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return getSummarySince(since, 'Last 24 Hours');
}