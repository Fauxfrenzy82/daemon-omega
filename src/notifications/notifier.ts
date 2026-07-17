import axios from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
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

function sanitizeFields(fields: AlertFields): AlertFields {
  const sanitized: AlertFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;

    if (typeof value === 'string' && value.includes('alchemy.com/v2/')) {
      sanitized[key] = value.replace(/\/v2\/[^\/\s]+/, '/v2/REDACTED');
      continue;
    }

    if (typeof value === 'string' && value.startsWith('0x') && value.length > 100) {
      sanitized[key] = value.slice(0, 30) + '...' + value.slice(-6);
      continue;
    }

    if (typeof value === 'object' && value !== null) {
      try {
        sanitized[key] = JSON.stringify(value);
      } catch {
        sanitized[key] = '[unserializable object]';
      }
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

export async function sendAlert(
  level: AlertLevel,
  title: string,
  fields: AlertFields = {}
): Promise<void> {
  const safeFields = sanitizeFields(fields);

  const logFn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
  logFn(title, safeFields);

  if (!env.DISCORD_WEBHOOK_URL) {
    return;
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
    log.warn('Discord alert failed to send', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function isDiscordConfigured(): boolean {
  return env.DISCORD_WEBHOOK_URL !== '';
}

// ===== Convenience wrappers =====
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

// ===== NEW: Period summary alert =====
export async function alertPeriodSummary(summary: PeriodSummary): Promise<void> {
  const profitColor = summary.totalActualProfitUsd >= 0 ? 3066993 : 15158332; // green or red

  const fields: AlertFields = {
    Period: summary.periodLabel,
    'Confirmed Trades': String(summary.confirmedTrades),
    'Failed Attempts': String(summary.failedTrades),
    'Total Profit (USD)': `$${summary.totalActualProfitUsd.toFixed(4)}`,
    'Avg Profit / Trade': `$${summary.avgProfitPerTradeUsd.toFixed(4)}`,
    'Best Trade': summary.bestTrade
      ? `${summary.bestTrade.pairId}: $${summary.bestTrade.profitUsd.toFixed(4)}`
      : 'none',
  };

  // We want a custom color, so we bypass the level color map and use sendAlert with a level but we override color?
  // We'll use sendAlert with level 'info' and then we can't change color easily.
  // Instead, we'll replicate the send logic manually to set color.
  // But to keep things simple, we'll use a custom send function that uses the profitColor.
  // However, sendAlert uses LEVEL_COLOR. We can add a special case.
  // Let's just call sendAlert with 'info' and accept the blue color, or we can add a color override parameter.
  // I'll implement a small internal helper that sends the embed directly.

  // Simpler: use sendAlert but override color by passing a custom field? That won't work.
  // Let's just directly post the embed to Discord, reusing the retry logic.

  // For brevity and to avoid changing sendAlert signature, we'll use a direct post here.
  // But we already have sendAlert that expects level. Let's modify sendAlert to accept optional color parameter,
  // or we can just use the existing function with 'info' and accept the blue color – but that's not as nice.
  // I'll create a private function to send with custom color.

  // Actually, let's extend sendAlert to accept an optional `color` override:
  // But we can't change the signature without breaking all callers.
  // Alternative: call sendAlert with a level that gives the desired color? Not possible.
  // I'll just use axios directly and reuse the retry logic.

  // Since this is a summary, it's fine to use the generic 'info' color (blue) or we can make it green/red by using 'success'/'error' level.
  // But we want dynamic color. So we'll send a separate request.

  // I'll refactor to use sendAlert with a temporary level set based on profit.
  const level: AlertLevel = summary.totalActualProfitUsd >= 0 ? 'success' : 'error';
  await sendAlert(level, `📊 ${summary.periodLabel} Summary`, fields);
}