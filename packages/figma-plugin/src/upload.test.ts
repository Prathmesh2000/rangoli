import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { LIMITS } from './limits.js';
import { sha256Hex } from './sha256.js';
import { SERVERS, UploadError, uploadExport } from './upload.js';

const SERVER = SERVERS[0].url;
const TOKEN = 'rng_import_0123456789abcdef';
const KEY = 'upload_key_0123456789abcdef';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function server(respond: (call: Call, attempt: number) => Response | Error) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('Authorization'),
      body: init?.body,
    };
    calls.push(call);
    const attempt = (attempts.get(call.url) ?? 0) + 1;
    attempts.set(call.url, attempt);
    const result = respond(call, attempt);
    if (result instanceof Error) throw result;
    return result;
  });
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

const happy = (call: Call): Response => {
  if (call.url.endsWith('/uploads')) return json(201, { uploadId: 'up_1', uploadKey: KEY });
  if (call.url.endsWith('/complete')) return json(200, { importId: 'imp_1' });
  return new Response(null, { status: 204 });
};

const noSleep = async () => {};
const base = { serverUrl: SERVER, token: TOKEN, sleep: noSleep };
const errorCode = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UploadError) return error.code;
    throw error;
  }
  return 'no-error';
};

describe('uploadExport', () => {
  it('splits into ordered chunks and spends the token only once', async () => {
    const bytes = Uint8Array.from({ length: 25 }, (_, i) => i);
    const { calls, fetchFn } = server(happy);
    const progress: number[] = [];
    const result = await uploadExport({ ...base, bytes, fetchFn, chunkBytes: 10, onProgress: (sent) => progress.push(sent) });

    expect(result).toEqual({ importId: 'imp_1' });
    expect(calls.map((c) => `${c.method} ${c.url.replace(SERVER, '')}`)).toEqual([
      'POST /api/import/figma/uploads',
      'PUT /api/import/figma/uploads/up_1/chunks/0',
      'PUT /api/import/figma/uploads/up_1/chunks/1',
      'PUT /api/import/figma/uploads/up_1/chunks/2',
      'POST /api/import/figma/uploads/up_1/complete',
    ]);
    expect(calls.filter((c) => c.auth === `Bearer ${TOKEN}`)).toHaveLength(1);
    expect(calls.slice(1).every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);

    const reassembled = calls.slice(1, 4).flatMap((c) => [...(c.body as Uint8Array)]);
    expect(reassembled).toEqual([...bytes]);
    expect(progress).toEqual([10, 20, 25]);

    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      format: 'rangoli.figma-export',
      schemaVersion: 1,
      totalBytes: 25,
      chunkBytes: 10,
      chunkCount: 3,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('keeps default chunks under the 2 MB server body cap', () => {
    expect(LIMITS.chunkBytes).toBeLessThan(2_000_000);
  });

  it('never retries the token request', async () => {
    const network = server(() => new TypeError('failed'));
    expect(await errorCode(uploadExport({ ...base, bytes: new Uint8Array(1), fetchFn: network.fetchFn }))).toBe('token-state-unknown');
    expect(network.calls).toHaveLength(1);

    const down = server(() => json(503, {}));
    expect(await errorCode(uploadExport({ ...base, bytes: new Uint8Array(1), fetchFn: down.fetchFn }))).toBe('token-state-unknown');
    expect(down.calls).toHaveLength(1);

    const rejected = server(() => json(401, {}));
    expect(await errorCode(uploadExport({ ...base, bytes: new Uint8Array(1), fetchFn: rejected.fetchFn }))).toBe('token-rejected');
  });

  it('retries transient chunk failures, then succeeds', async () => {
    const { calls, fetchFn } = server((call, attempt) => {
      if (call.url.includes('/chunks/0')) {
        if (attempt === 1) return new TypeError('reset');
        if (attempt === 2) return json(503, {});
      }
      return happy(call);
    });
    await uploadExport({ ...base, bytes: new Uint8Array(5), fetchFn, chunkBytes: 10 });
    expect(calls.filter((c) => c.url.includes('/chunks/0'))).toHaveLength(3);
  });

  it('gives up after the attempt limit, and at once on client errors', async () => {
    const transient = server((call) => (call.url.includes('/chunks/') ? json(500, {}) : happy(call)));
    expect(await errorCode(uploadExport({ ...base, bytes: new Uint8Array(5), fetchFn: transient.fetchFn, maxAttempts: 3 }))).toBe('chunk-failed');
    expect(transient.calls.filter((c) => c.url.includes('/chunks/'))).toHaveLength(3);

    const forbidden = server((call) => (call.url.includes('/chunks/') ? json(403, {}) : happy(call)));
    expect(await errorCode(uploadExport({ ...base, bytes: new Uint8Array(5), fetchFn: forbidden.fetchFn }))).toBe('chunk-failed');
    expect(forbidden.calls.filter((c) => c.url.includes('/chunks/'))).toHaveLength(1);
  });

  it('refuses servers off the allow list and malformed tokens before any request', async () => {
    const { calls, fetchFn } = server(happy);
    expect(await errorCode(uploadExport({ ...base, serverUrl: 'https://evil.example', bytes: new Uint8Array(1), fetchFn }))).toBe('server-not-allowed');
    expect(await errorCode(uploadExport({ ...base, token: 'bad token\r\nX: y', bytes: new Uint8Array(1), fetchFn }))).toBe('invalid-token-format');
    expect(calls).toHaveLength(0);
  });

  it('refuses oversized exports before any request', async () => {
    const { calls, fetchFn } = server(happy);
    const bytes = { byteLength: LIMITS.maxExportBytes + 1 } as Uint8Array;
    expect(await errorCode(uploadExport({ ...base, bytes, fetchFn }))).toBe('too-large');
    expect(calls).toHaveLength(0);
  });

  it('rejects upload ids that could change the path', async () => {
    const { calls, fetchFn } = server(() => json(201, { uploadId: '../../admin', uploadKey: KEY }));
    expect(await errorCode(uploadExport({ ...base, bytes: new Uint8Array(1), fetchFn }))).toBe('bad-response');
    expect(calls).toHaveLength(1);
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    const { calls, fetchFn } = server((call) => {
      if (call.url.includes('/chunks/0')) abort.abort();
      return happy(call);
    });
    expect(await errorCode(uploadExport({ ...base, bytes: new Uint8Array(30), fetchFn, chunkBytes: 10, signal: abort.signal }))).toBe('cancelled');
    expect(calls.filter((c) => c.url.includes('/chunks/1'))).toHaveLength(0);
  });
});

describe('sha256Hex', () => {
  it('matches node:crypto around block boundaries', () => {
    for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31) & 0xff);
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('matches the published vector for "abc"', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
    documentAccess: string;
    editorType: string[];
    networkAccess: { allowedDomains: string[]; devAllowedDomains: string[]; reasoning: string };
  };

  it('uses dynamic page access in Figma only', () => {
    expect(manifest.documentAccess).toBe('dynamic-page');
    expect(manifest.editorType).toEqual(['figma']);
  });

  it('allows exactly the servers the UI offers, with no wildcard', () => {
    const allowed = [...manifest.networkAccess.allowedDomains, ...manifest.networkAccess.devAllowedDomains];
    expect(allowed.sort()).toEqual(SERVERS.map((s) => s.url).sort());
    expect(allowed).not.toContain('*');
    expect(manifest.networkAccess.allowedDomains.every((d) => d.startsWith('https://'))).toBe(true);
    expect(manifest.networkAccess.reasoning.length).toBeGreaterThan(0);
  });
});
