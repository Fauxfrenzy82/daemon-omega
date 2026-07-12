import axios from 'axios';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

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

export async function sendAlert(
  level: AlertLevel,
  title: string,
  fields: AlertFields = {}
): Promise<void> {
  const logFn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
  logFn(title, fields);

  if (!env.DISCORD_WEBHOOK_URL) {
    return;
  }

  try {
    const embed = {
      title,
      color: LEVEL_COLOR[level],
      fields: Object.entries(fields)
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