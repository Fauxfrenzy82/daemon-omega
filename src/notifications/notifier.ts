import axios from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
import { PeriodSummary } from '../reporting/summary';
import { RateLimiter } from '../utils/rateLimiter';

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

// Rate limiter: one Discord message every 5 seconds (burst of 1)
const discordLimiter = new RateLimiter(1, 5000, 'discord');

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
  fields: AlertFields = {},
  retry: boolean = true
): Promise<void> {
  const safeFields = sanitizeFields(fields);

  const logFn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
  logFn(title, safeFields);

  if (!env.DISCORD_WEBHOOK_URL) {
    return;
  }

  // Acquire rate limiter token – one message per 5 seconds
  await discordLimiter.acquire();

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

    const requestFn = () =>
      axios.post(
        env.DISCORD_WEBHOOK_URL,
        { embeds: [embed] },
        { timeout: 5000 }
      );

    if (retry) {
      await withRetry(
        requestFn,
        { label: 'notifier.discord', shouldRetry: isTransientError, retries: 2 }
      );
    } else {
      await requestFn();
    }
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
  // Do not retry startup notification – it's non‑critical and Cloudflare rate‑limits aggressively
  return sendAlert('info', 'System Started', { executionWallet }, false);
}

export async function alertPeriodSummary(summary: PeriodSummary): Promise<void> {
  const level: AlertLevel = summary.totalActualProfitUsd >= 0 ? 'success' : 'error';
  await sendAlert(level, `📊 ${summary.periodLabel} Summary`, {
    Period: summary.periodLabel,
    'Confirmed Trades': String(summary.confirmedTrades),
    'Failed Attempts': String(summary.failedTrades),
    'Total Profit (USD)': `$${summary.totalActualProfitUsd.toFixed(4)}`,
    'Avg Profit / Trade': `$${summary.avgProfitPerTradeUsd.toFixed(4)}`,
    'Best Trade': summary.bestTrade
      ? `${summary.bestTrade.pairId}: $${summary.bestTrade.profitUsd.toFixed(4)}`
      : 'none',
  });
}