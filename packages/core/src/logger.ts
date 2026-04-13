/**
 * Structured logger. Emits single-line JSON so it's cheap to pipe into
 * Cloudflare's Tail Worker / Logpush pipelines and also grep-friendly locally.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minLevel = LEVEL_ORDER[opts.level ?? 'info'];
  const base = opts.base ?? {};

  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const entry = {
      level,
      time: new Date().toISOString(),
      msg,
      ...base,
      ...fields,
    };
    // Workers console.log flushes to Tail; Node prints to stdout. Both fine.
    console.log(JSON.stringify(entry));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child(bindings) {
      return createLogger({ level: opts.level, base: { ...base, ...bindings } });
    },
  };
}
