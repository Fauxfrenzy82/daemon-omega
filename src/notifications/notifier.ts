import axios from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
// --- Added import for PeriodSummary ---
import { PeriodSummary } from '../reporting/summary';

const log = createLogger('notifier');

export type AlertLevel = 'info' | 'success' | 'warn' | 'error';

const LEVEL_COLOR: Record<AlertLevel, number> = {
  info: 0x3498db,
  success: 0x2ecc71,
  warn: 0xf1c40f,
  error: 0xe74c3c,
};

export interface AlertFields {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Sanitize fields before sending to Discord:
 * - Redact Alchemy API keys in URLs
 * - Truncate long hex strings (raw transaction data)
 * - Convert any non-primitive values to strings to avoid Discord embed issues
 */
function sanitizeFields(fields: AlertFields): AlertFields {
  const sanitized: AlertFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;

    // Redact API keys in URLs
    if (typeof value === 'string' && value.includes('alchemy.com/v2/')) {
      sanitized[key] = value.replace(/\/v2\/[^\/\s]+/, '/v2/REDACTED');
      continue;
    }

    // Truncate long hex strings (raw transactions, etc.)
    if (typeof value === 'string' && value.startsWith('0x') && value.length > 100) {
      sanitized[key] = value.slice(0, 30) + '...' + value.slice(-6);
      continue;
    }

    // If it's an object or array, stringify it (Discord embed fields expect primitives)
    if (typeof value === 'object' && value !== null) {
      try {
        sanitized[key] = JSON.stringify(value);
      } catch {
        sanitized[key] = '[unserializable object]';
      }
      continue;
    }

    // Keep primitives as-is
    sanitized[key] = value;
  }

  return sanitized;
}

/**
 * Central alert dispatcher with sanitization.
 * Always logs locally, then sends to Discord if webhook is configured.
 */
export async function sendAlert(
  level: AlertLevel,
  title: string,
  fields: AlertFields = {}
): Promise<void> {
  // Sanitize before logging and before sending to Discord
  const safeFields = sanitizeFields(fields);

  // Always log locally (sanitized)
  const logFn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
  logFn(title, safeFields);

  if (!env.DISCORD_WEBHOOK_URL) {
    return; // No webhook configured — log line above is the full alert
  }

  try {
    const embed = {
      title,
      color: LEVEL_COLOR[level],
      fields: Object.entries(safeFields)
        .filter(([, v]) => v !== undefined)
        .map(([name, value]) => ({
          name,
          value: String(value),
          inline: String(value).length < 20,
        })),
      timestamp: new Date().toISOString(),
    };

    await withRetry(
      () =>
        axios.post(
          env.DISCORD_WEBHOOK_URL,
          { embeds: [embed] },
          { timeout: 5000 }
        ),
      { label: 'notifier.discord', shouldRetry: isTransientError, retries: 2 }
    );
  } catch (err) {
    // A failed Discord post must never break the trading flow — log and move on.
    log.warn('Discord alert failed to send', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function isDiscordConfigured(): boolean {
  return env.DISCORD_WEBHOOK_URL !== '';
}

// ============================================================================
// Convenience wrappers for common alert types across the system.
// Each wrapper calls sendAlert with the appropriate level and field structure.
// ============================================================================

export function alertTradeExecuted(pairId: string, netProfitUsd: number, txHash: string): Promise<void> {
  return sendAlert('success', 'Trade Executed', {
    pair: pairId,
    netProfitUsd: netProfitUsd.toFixed(4),
    txHash,
  });
}

export function alertTradeFailed(pairId: string, reason: string): Promise<void> {
  return sendAlert('warn', 'Trade Failed', { pair: pairId, reason });
}

export function alertSweepCompleted(tokenSymbol: string, amountUsd: number, txHash: string): Promise<void> {
  return sendAlert('success', 'Profit Swept to Treasury', {
    token: tokenSymbol,
    amountUsd: amountUsd.toFixed(4),
    txHash,
  });
}

export function alertSweepFailed(tokenSymbol: string, reason: string): Promise<void> {
  return sendAlert('error', 'Sweep Failed', { token: tokenSymbol, reason });
}

export function alertCircuitBreakerTripped(reason: string): Promise<void> {
  return sendAlert('error', 'Circuit Breaker TRIPPED --- Trading Halted', { reason });
}

export function alertCircuitBreakerReset(reason: string): Promise<void> {
  return sendAlert('info', 'Circuit Breaker Reset --- Trading Resumed', { reason });
}

export function alertSystemStarted(executionWallet: string): Promise<void> {
  return sendAlert('info', 'System Started', { executionWallet });
}

// --- New function for period summary alerts ---
export async function alertPeriodSummary(summary: PeriodSummary): Promise<void> {
  const profitColor = summary.totalActualProfitUsd >= 0 ? 3066993 : 15158332; // green or red
  const bestTradeText = summary.bestTrade
    ? `${summary.bestTrade.pairId}: $${summary.bestTrade.profitUsd.toFixed(4)}`
    : 'none';

  const fields = [
    { name: 'Period', value: summary.periodLabel, inline: true },
    { name: 'Confirmed Trades', value: String(summary.confirmedTrades), inline: true },
    { name: 'Failed Attempts', value: String(summary.failedTrades), inline: true },
    { name: 'Total Profit (USD)', value: `$${summary.totalActualProfitUsd.toFixed(4)}`, inline: true },
    { name: 'Avg Profit / Trade', value: `$${summary.avgProfitPerTradeUsd.toFixed(4)}`, inline: true },
    { name: 'Best Trade', value: bestTradeText, inline: false },
  ];

  // sendAlert expects level and title as separate arguments, then fields.
  await sendAlert('info', `📊 ${summary.periodLabel} Summary`, fields);
}