import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createLogger, logContext, redact, redactText, REDACTED } from './log.js';
import { InMemoryMetrics, startRuntimeMetrics } from './metrics.js';
import { observeRequest, readinessProbe, requestIdFrom } from './request.js';
import { setTracer } from './trace.js';

const capture = (level: 'debug' | 'info' | 'warn' | 'error' = 'debug') => {
  const lines: string[] = [];
  return { lines, log: createLogger({ level, sink: (l) => lines.push(l) }), last: () => JSON.parse(lines[lines.length - 1]!) };
};

describe('log redaction', () => {
  it.each([
    ['password', 'hunter2-hunter2'],
    ['DB_OWNER_PASSWORD', 'hunter2-hunter2'],
    ['authorization', 'Bearer rng_abc'],
    ['Cookie', 'rangoli_session=abc'],
    ['set-cookie', 'rangoli_session=abc'],
    ['token', 'abc'],
    ['tokenHash', 'abc'],
    ['apiKey', 'abc'],
    ['client_secret', 'abc'],
  ])('removes the value under %s', (key, value) => {
    expect(redact({ [key]: value })).toEqual({ [key]: REDACTED });
  });

  it('removes sensitive keys at any depth and in arrays', () => {
    expect(redact({ a: { b: [{ password: 'x', ok: 1 }] } })).toEqual({ a: { b: [{ password: REDACTED, ok: 1 }] } });
  });

  it.each([
    ['postgres://rangoli_owner:s3cret@db:5432/rangoli failed', 's3cret'],
    ['header was Bearer abc.def-ghi', 'abc.def-ghi'],
    ['agent used rng_AbC123-xyz', 'rng_AbC123-xyz'],
    ['Cookie: rangoli_session=sessvalue; theme=dark', 'sessvalue'],
    ['GET /invite/invitetoken123', 'invitetoken123'],
    ['Set a new password: https://x.io/reset/resettoken123', 'resettoken123'],
    ['GET /editor/?t=sharetoken123&x=1', 'sharetoken123'],
    ['password=abc123 host=db', 'abc123'],
    [`ALTER ROLE rangoli_login PASSWORD 'p4ssw0rd'`, 'p4ssw0rd'],
    ['AKIAIOSFODNN7EXAMPLE leaked', 'AKIAIOSFODNN7EXAMPLE'],
    ['hash scrypt$32768$c2FsdA==$aGFzaA==', 'aGFzaA=='],
  ])('scrubs secrets inside text: %s', (text, secret) => {
    expect(redactText(text)).not.toContain(secret);
    expect(redactText(text)).toContain(REDACTED);
  });

  it('leaves ordinary text and routes alone', () => {
    const text = 'password authentication failed for user "rangoli_login" at /api/orgs/1/invites/2';
    expect(redactText(text)).toBe(text);
  });

  it('redacts errors and omits Postgres fields that can quote row values', () => {
    const { log, last } = capture();
    const err = Object.assign(new Error('connect postgres://u:topsecret@db/x'), { code: '23505', detail: 'Key (email)=(asha@acme.io) already exists', where: 'row data' });
    log.error('failed', { err });
    const line = last();
    expect(JSON.stringify(line)).not.toContain('topsecret');
    expect(JSON.stringify(line)).not.toContain('asha@acme.io');
    expect(line.err).toMatchObject({ name: 'Error', code: '23505' });
    expect(line.err.stack).toBeTypeOf('string');
  });

  it('survives circular values, BigInt and throwing getters', () => {
    const { log, lines, last } = capture();
    const loop: Record<string, unknown> = { n: 10n };
    loop.self = loop;
    log.info('circular', { loop });
    expect(last().loop).toEqual({ n: '10', self: '[Circular]' });
    const count = lines.length;
    log.info('throws', { bad: Object.defineProperty({}, 'x', { enumerable: true, get: () => { throw new Error('no'); } }) });
    expect(lines.length).toBe(count); // dropped, never thrown
  });

  it('redacts the message itself and bindings from child loggers', () => {
    const { log, last } = capture();
    log.child({ password: 'bound', service: 'app' }).warn('login with password=inline');
    expect(last()).toMatchObject({ level: 'warn', msg: `login with password=${REDACTED}`, password: REDACTED, service: 'app' });
  });

  it('writes one JSON object per line and honours the level', () => {
    const { log, lines } = capture('warn');
    log.info('hidden');
    log.warn('shown\nwith a newline');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0]!).time).toMatch(/^\d{4}-/);
  });

  it('cannot have its core fields overwritten', () => {
    const { log, last } = capture();
    log.info('real', { msg: 'forged', level: 'debug' });
    expect(last()).toMatchObject({ msg: 'real', level: 'info', _msg: 'forged', _level: 'debug' });
  });
});

describe('request ids', () => {
  const fakeExchange = (url: string, id?: string) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true, headers: {} as Record<string, unknown>, setHeader(k: string, v: unknown) { this.headers[k] = v; } });
    return { req: { url, method: 'GET', headers: id ? { 'x-request-id': id } : {} } as unknown as IncomingMessage, res, asRes: res as unknown as ServerResponse };
  };

  it('keeps a well-formed inbound id and replaces anything else', () => {
    expect(requestIdFrom('abc-12345')).toBe('abc-12345');
    for (const bad of ['short', 'has space inside', 'x'.repeat(200), 'a\r\nb: c-long-enough']) expect(requestIdFrom(bad)).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets the header, tags lines logged in the handler, and logs the path without its query or token', () => {
    const { log, lines, last } = capture();
    const sink = new InMemoryMetrics();
    const { req, res, asRes } = fakeExchange('/invite/tok123456?t=abc', 'req-12345');
    observeRequest(req, asRes, () => {
      expect(logContext.getStore()?.requestId).toBe('req-12345');
      log.warn('inside');
      expect(last().requestId).toBe('req-12345');
    }, { log, metrics: sink });
    expect(res.headers['x-request-id']).toBe('req-12345');
    res.statusCode = 500;
    res.emit('close');
    expect(last()).toMatchObject({ msg: 'request', requestId: 'req-12345', status: 500, method: 'GET', path: `/invite/${REDACTED}` });
    expect(lines.join('')).not.toContain('tok123456');
    expect(lines.join('')).not.toContain('abc');
    expect(sink.snapshot().counters['http.server_errors']).toBe(1);
  });

  it('does not log health checks', () => {
    const { log, lines } = capture();
    const { req, res, asRes } = fakeExchange('/readyz');
    observeRequest(req, asRes, () => undefined, { log });
    res.emit('close');
    expect(lines).toHaveLength(0);
  });

  it('runs through a pluggable tracer', () => {
    const span = vi.fn((_n: string, _a: object, fn: () => unknown) => fn());
    setTracer({ span: span as never });
    try {
      const { req, asRes } = fakeExchange('/readyz');
      expect(observeRequest(req, asRes, () => 42)).toBe(42);
      expect(span).toHaveBeenCalledOnce();
    } finally {
      setTracer(null);
    }
  });
});

describe('readiness', () => {
  const silent = createLogger({ level: 'error', sink: () => undefined });

  it('reports failure without passing on the reason', async () => {
    const lines: string[] = [];
    const probe = readinessProbe(() => Promise.reject(new Error('connect postgres://u:leak@internal-host/db')), { cacheMs: 0, log: createLogger({ sink: (l) => lines.push(l), level: 'warn' }) });
    await expect(probe()).resolves.toBe(false);
    expect(lines[0]).toContain('readiness check failed');
    expect(lines[0]).not.toContain('leak');
  });

  it('times out instead of hanging', async () => {
    await expect(readinessProbe(() => new Promise(() => undefined), { timeoutMs: 20, cacheMs: 0, log: silent })()).resolves.toBe(false);
  });

  it('shares one check across callers inside the cache window', async () => {
    const check = vi.fn(async () => 1);
    const probe = readinessProbe(check, { cacheMs: 60_000, log: silent });
    expect(await Promise.all([probe(), probe()])).toEqual([true, true]);
    await probe();
    expect(check).toHaveBeenCalledOnce();
  });
});

describe('metrics', () => {
  it('summarizes samples and starts a new window on reset', () => {
    const m = new InMemoryMetrics();
    m.observe('db.pool.wait_ms', 2);
    m.observe('db.pool.wait_ms', 6);
    m.increment('e');
    m.gauge('g', 7);
    expect(m.snapshot({ reset: true })).toEqual({ counters: { e: 1 }, gauges: { g: 7 }, distributions: { 'db.pool.wait_ms': { count: 2, sum: 8, max: 6 } } });
    expect(m.snapshot()).toEqual({ counters: {}, gauges: { g: 7 }, distributions: {} });
  });

  it('reports heap and event-loop lag through the log', async () => {
    const { log, lines } = capture();
    const target = new InMemoryMetrics();
    const stop = startRuntimeMetrics({ metrics: target, log, intervalMs: 60 });
    await new Promise((ok) => setTimeout(ok, 200));
    stop();
    const reported = JSON.parse(lines[lines.length - 1]!);
    expect(reported.msg).toBe('metrics');
    expect(reported.metrics.gauges['runtime.heap_used_bytes']).toBeGreaterThan(0);
    expect(reported.metrics.gauges['runtime.event_loop_lag_max_ms']).toBeGreaterThanOrEqual(0);
  });
});
