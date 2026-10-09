import { DomainError } from './errors.js';

const sensitiveKey =
  /(?:password|passwd|secret|token|authorization|cookie|api.?key|private.?key|credential|recovery.?code|ciphertext|master.?key|assertion|attestation|client.?data|authenticator.?data|email|invite)/i;
const sensitiveValue =
  /(?:Bearer\s+\S+|Basic\s+\S+|(?:gh[pousr]_|github_pat_|ptla_|ptlc_)[A-Za-z0-9_]+|[a-z][a-z\d+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/gi;
const sensitiveQuery = /([?&](?:token|code|state|password|secret|key|signature|invite)=[^&#\s]*)/gi;
const sensitivePath = /(\/(?:invite|reset-password|verify-email)\/)\S+/gi;

/** Logs should use fixed event names + structured metadata, never request bodies. */
export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function visit(item: unknown, depth: number): unknown {
    if (depth > 10) return '[Truncated]';
    if (typeof item === 'string')
      return item
        .replace(sensitiveValue, '[REDACTED]')
        .replace(sensitiveQuery, '[REDACTED]')
        .replace(sensitivePath, '$1[REDACTED]');
    if (typeof item === 'bigint') return item.toString();
    if (item === null || typeof item !== 'object') return item;
    if (item instanceof DomainError)
      return {
        name: item.name,
        code: item.code,
        status: item.status,
        details: visit(item.details, depth + 1),
      };
    if (item instanceof Error) return { name: 'Error', code: 'internal_error' };
    if (item instanceof Uint8Array) return '[REDACTED]';
    if (item instanceof Date) return item.toISOString();
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 100).map((entry) => visit(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(item)
        .slice(0, 100)
        .map(([key, entry]) => [
          key,
          sensitiveKey.test(key) ? '[REDACTED]' : visit(entry, depth + 1),
        ]),
    );
  }
  return visit(value, 0);
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogRecord {
  time: string;
  level: LogLevel;
  event: string;
  data: unknown;
}

export function createLogger(
  sink: (record: LogRecord) => void,
  options: { level?: LogLevel; now?: () => Date } = {},
) {
  const ranks: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  return {
    log(level: LogLevel, event: string, data: Readonly<Record<string, unknown>> = {}): void {
      if (ranks[level] < ranks[options.level ?? 'info']) return;
      if (!/^[a-z][a-z0-9_.-]{0,95}$/.test(event))
        throw new TypeError('Invalid log event identifier');
      sink({
        time: (options.now?.() ?? new Date()).toISOString(),
        level,
        event,
        data: redact(data),
      });
    },
  };
}
