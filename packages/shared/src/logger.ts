// Structured JSON logger with bound context. No PII beyond what callers pass.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export function createLogger(context: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, msg, ...context, ...fields, ts: Date.now() });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (ctx) => createLogger({ ...context, ...ctx }),
  };
}
