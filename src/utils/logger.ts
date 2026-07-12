import { env } from '../config/env';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const activeLevel: LogLevel = (env.LOG_LEVEL as LogLevel) in LEVEL_ORDER
  ? (env.LOG_LEVEL as LogLevel)
  : 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[activeLevel];
}

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: LogLevel, scope: string, message: string, meta?: unknown): string {
  const base = `[${timestamp()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  if (meta === undefined) return base;
  try {
    return `${base} ${JSON.stringify(meta)}`;
  } catch {
    return `${base} [unserializable meta]`;
  }
}

export function createLogger(scope: string) {
  return {
    debug(message: string, meta?: unknown) {
      if (shouldLog('debug')) console.debug(format('debug', scope, message, meta));
    },
    info(message: string, meta?: unknown) {
      if (shouldLog('info')) console.info(format('info', scope, message, meta));
    },
    warn(message: string, meta?: unknown) {
      if (shouldLog('warn')) console.warn(format('warn', scope, message, meta));
    },
    error(message: string, meta?: unknown) {
      if (shouldLog('error')) console.error(format('error', scope, message, meta));
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;