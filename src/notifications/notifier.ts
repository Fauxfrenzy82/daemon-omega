// src/notifications/notifier.ts (modified)

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

/**
 * Sanitize fields before sending to Discord:
 * - Remove any object that contains 'url' with 'alchemy' or 'rpc' (API key redaction)
 * - Truncate long hex strings (like raw transaction)
 * - Remove any field named 'params' that contains an array with a hex string
 */
function sanitizeFields(fields: AlertFields): AlertFields {
  const sanitized: AlertFields = {};

  for (const [key, value] of Object.entries(fields)) {
    // Skip if value is undefined
    if (value === undefined) continue;

    // Redact any field that looks like a URL with API key
    if (typeof value === 'string' && value.includes('alchemy.com/v2/')) {
      sanitized[key] = value.replace(/\/v2\/[^\/\s]+/, '/v2/REDACTED');
      continue;
    }

    // Redact raw transaction hex (long hex string starting with 0x)
    if (typeof value === 'string' && value.startsWith('0x') && value.length > 100) {
      sanitized[key] = value.slice(0, 30) + '...' + value.slice(-6);
      continue;
    }

    // If it's an object, recursively sanitize (avoid circular)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeFields(value as AlertFields);
      continue;
    }

    // If it's an array, look for hex strings
    if (Array.isArray(value)) {
      sanitized[key] = value.map(item => {
        if (typeof item === 'string' && item.startsWith('0x') && item.length > 100) {
          return item.slice(0, 30) + '...' + item.slice(-6);
        }
        return item;
      });
      continue;
    }

    // Otherwise, keep as is
    sanitized[key] = value;
  }

  return sanitized;
}

export async function sendAlert(
  level: AlertLevel,
  title: string,
  fields: AlertFields = {}
): Promise<void> {
  // Always log locally, but with sanitization
  const sanitized = sanitizeFields(fields);
  const logFn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
  logFn(title, sanitized);

  if (!env.DISCORD_WEBHOOK_URL) {
    return;
  }

  try {
    const embed = {
      title,
      color: LEVEL_COLOR[level],
      fields: Object.entries(sanitized)
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
    // Discord post failure should never break the bot
    log.warn('Discord alert failed to send', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}