/**
 * Structured logs: one JSON object per line on stderr (stdout is reserved for MCP).
 * Everything is redacted on the way out, so a call site cannot leak a credential by forgetting to.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  bindings?: LogFields;
}

/** The request behind the current async call, added to every line logged while handling it. */
export const logContext = new AsyncLocalStorage<{ requestId: string }>();

export const REDACTED = '[REDACTED]';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_DEPTH = 6;
const MAX_ITEMS = 100;
const MAX_STRING = 8192;

// over-matching is the safe direction: a redacted tokenCount costs little, a logged session costs a lot
const SENSITIVE_KEY = /password|passwd|passphrase|pwd|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|session/i;

const SENSITIVE_TEXT: [RegExp, string][] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s/@]+@/gi, `$1:${REDACTED}@`], // postgres://user:password@host
  [/\bbearer\s+[\w.~+/=-]+/gi, `Bearer ${REDACTED}`],
  [/\brng_[\w-]+/g, REDACTED], // API tokens
  [/\b(rangoli_session)=[^;\s"']+/g, `$1=${REDACTED}`],
  [/(\/(?:invite|reset)\/)[^/?#\s"']+/g, `$1${REDACTED}`], // invite and reset links carry the token in the path
  [/([?&](?:t|token|password|secret|code|key)=)[^&#\s"']+/gi, `$1${REDACTED}`],
  [/\b(password|passwd|pwd|secret|token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1$2${REDACTED}`],
  [/\b(password\s+)'[^']*'/gi, `$1${REDACTED}`], // ALTER ROLE ... PASSWORD '...'
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bscrypt\$[^\s"']+/g, REDACTED],
];

export function redactText(text: string): string {
  let out = text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}...[truncated]` : text;
  for (const [pattern, replacement] of SENSITIVE_TEXT) out = out.replace(pattern, replacement);
  return out;
}

/** Only fields known to be safe: a Postgres error's `detail` and `where` can quote row values. */
function errorFields(e: Error, seen: WeakSet<object>, depth: number): LogFields {
  const code = (e as { code?: unknown }).code;
  return {
    name: e.name,
    message: redactText(e.message),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(e.stack ? { stack: redactText(e.stack) } : {}),
    ...(e.cause !== undefined ? { cause: redactValue(e.cause, seen, depth + 1) } : {}),
  };
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof URL) return redactText(value.href);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary]';
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  if (value instanceof Error) return errorFields(value, seen, depth);
  if (value instanceof Set) return redactValue([...value], seen, depth);
  if (value instanceof Map) return redactValue(Object.fromEntries(value), seen, depth);
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => redactValue(v, seen, depth + 1));
  const out: LogFields = {};
  for (const [k, v] of Object.entries(value).slice(0, MAX_ITEMS)) out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, seen, depth + 1);
  return out;
}

/** A redacted copy that is always safe to pass to JSON.stringify. */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet(), 0);
}

function envLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  if (level && level in ORDER) return level as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'info' : 'warn';
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const threshold = ORDER[opts.level ?? envLevel()];
  const sink = opts.sink ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const bindings = opts.bindings ?? {};
  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < threshold) return;
    try {
      const requestId = logContext.getStore()?.requestId;
      const entry: LogFields = { time: new Date().toISOString(), level, msg: redactText(msg), ...(requestId ? { requestId } : {}) };
      const extra = redact({ ...bindings, ...fields }) as LogFields;
      for (const [k, v] of Object.entries(extra)) if (entry[k] !== v) entry[k in entry ? `_${k}` : k] = v;
      sink(JSON.stringify(entry));
    } catch {
      // a log line must never be the thing that takes a request down
    }
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (more) => createLogger({ level: opts.level ?? envLevel(), sink, bindings: { ...bindings, ...more } }),
  };
}

export const logger: Logger = createLogger();
