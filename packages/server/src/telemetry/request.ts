/** Per-request observability and the readiness check behind /readyz. */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logContext, logger, type Logger } from './log.js';
import { metrics, type Metrics } from './metrics.js';
import { tracer } from './trace.js';

// an inbound id is only reused when it cannot smuggle anything into a header or a log query
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;
const QUIET_PATHS = new Set(['/healthz', '/readyz']);

export function requestIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}

export interface ObserveOptions {
  log?: Logger;
  metrics?: Metrics;
}

/** Tags the response with a request id, runs the handler in that context, and logs the outcome. */
export function observeRequest<T>(req: IncomingMessage, res: ServerResponse, handler: () => T, opts: ObserveOptions = {}): T {
  const requestId = requestIdFrom(req.headers['x-request-id']);
  res.setHeader('x-request-id', requestId);
  const path = (req.url ?? '/').split(/[?#]/, 1)[0]!; // the query string is not worth the risk of logging it
  const method = req.method ?? 'GET';
  if (!QUIET_PATHS.has(path)) {
    const log = (opts.log ?? logger).child({ requestId });
    const sink = opts.metrics ?? metrics;
    const started = performance.now();
    res.once('close', () => {
      const ms = Math.round((performance.now() - started) * 100) / 100;
      sink.observe('http.request_ms', ms);
      if (res.statusCode >= 500) sink.increment('http.server_errors');
      log.info('request', { method, path, status: res.statusCode, ms, ...(res.writableFinished ? {} : { aborted: true }) });
    });
  }
  return logContext.run({ requestId }, () => tracer().span('http.request', { 'http.method': method }, handler));
}

export interface ReadinessOptions {
  timeoutMs?: number;
  /** /readyz is unauthenticated, so repeated calls must not each cost a database round trip */
  cacheMs?: number;
  log?: Logger;
}

/** Wraps a dependency check as a yes or no. The reason goes to the log and never to the caller. */
export function readinessProbe(check: () => Promise<unknown>, opts: ReadinessOptions = {}): () => Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const cacheMs = opts.cacheMs ?? 1000;
  const log = opts.log ?? logger;
  let cached: { at: number; ok: boolean } | undefined;
  let running: Promise<boolean> | undefined;
  const run = async () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_ok, fail) => {
      timer = setTimeout(() => fail(new Error(`readiness check timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      await Promise.race([check(), timeout]);
      return true;
    } catch (err) {
      log.warn('readiness check failed', { err });
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  return () => {
    if (cached && performance.now() - cached.at < cacheMs) return Promise.resolve(cached.ok);
    running ??= run().then((ok) => {
      cached = { at: performance.now(), ok };
      running = undefined;
      return ok;
    });
    return running;
  };
}
