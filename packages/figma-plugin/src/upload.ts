import { EXPORT_FORMAT, LIMITS, SCHEMA_VERSION } from './limits.js';
import { sha256Hex } from './sha256.js';

/**
 * Chunked upload, against a contract the server still has to implement:
 *
 *   POST /api/import/figma/uploads          Authorization: Bearer <import token>
 *     { format, schemaVersion, totalBytes, chunkBytes, chunkCount, sha256 }
 *     -> 201 { uploadId, uploadKey }
 *   PUT  /api/import/figma/uploads/:id/chunks/:index   Authorization: Bearer <uploadKey>
 *     application/octet-stream -> 2xx, idempotent per index
 *   POST /api/import/figma/uploads/:id/complete        Authorization: Bearer <uploadKey>
 *     -> 200 { importId }
 *
 * The token is spent by the first request, so that request is never retried,
 * and the short-lived upload key carries the rest. Plugin iframes have a null
 * origin, so the server must answer with `Access-Control-Allow-Origin: *` and
 * list `Authorization` in `Access-Control-Allow-Headers`.
 */

/** Keep in step with `networkAccess` in manifest.json; the test suite checks it. */
export const SERVERS = [
  { label: 'Rangoli', url: 'https://app.rangoli.dev' },
  { label: 'Local development', url: 'http://localhost:4400' },
] as const;

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;

export function isPlausibleToken(token: string): boolean {
  return TOKEN.test(token);
}

export type UploadErrorCode =
  | 'invalid-token-format'
  | 'server-not-allowed'
  | 'too-large'
  | 'token-rejected'
  | 'token-state-unknown'
  | 'bad-response'
  | 'chunk-failed'
  | 'complete-failed'
  | 'cancelled';

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadOptions {
  serverUrl: string;
  token: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  chunkBytes?: number;
  maxAttempts?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  } catch {
    // Reported by the caller as a malformed response.
  }
  return {};
}

export async function uploadExport(options: UploadOptions): Promise<{ importId: string }> {
  const { serverUrl, token, bytes, signal } = options;
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const chunkBytes = options.chunkBytes ?? LIMITS.chunkBytes;
  const maxAttempts = options.maxAttempts ?? 4;

  if (!SERVERS.some((server) => server.url === serverUrl)) {
    throw new UploadError('server-not-allowed', 'That server is not on this plugin\'s allowed list.');
  }
  if (!isPlausibleToken(token)) {
    throw new UploadError('invalid-token-format', 'That import token doesn\'t look right. Copy it again from Rangoli.');
  }
  if (bytes.byteLength > LIMITS.maxExportBytes) {
    throw new UploadError('too-large', 'This export is over the size limit. Choose fewer frames or leave out images.');
  }

  const base = `${serverUrl}/api/import/figma/uploads`;
  const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / chunkBytes));
  const throwIfAborted = () => {
    if (signal?.aborted) throw new UploadError('cancelled', 'Upload cancelled.');
  };

  throwIfAborted();
  let start: Response;
  try {
    start = await fetchFn(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: EXPORT_FORMAT,
        schemaVersion: SCHEMA_VERSION,
        totalBytes: bytes.byteLength,
        chunkBytes,
        chunkCount,
        sha256: sha256Hex(bytes),
      }),
      ...(signal && { signal }),
    });
  } catch (error) {
    if (isAbort(error)) throw new UploadError('cancelled', 'Upload cancelled.');
    throw new UploadError(
      'token-state-unknown',
      'The connection failed before Rangoli answered. The token may already be used, so create a new one and try again.',
    );
  }
  if (!start.ok) {
    if (start.status >= 500) {
      throw new UploadError('token-state-unknown', `Rangoli returned ${start.status}. The token may already be used, so create a new one and try again.`);
    }
    throw new UploadError('token-rejected', 'Rangoli rejected this token. It may have expired or been used. Create a new one and try again.');
  }

  const session = await readJson(start);
  const uploadId = session['uploadId'];
  const uploadKey = session['uploadKey'];
  if (
    typeof uploadId !== 'string' ||
    !SAFE_SEGMENT.test(uploadId) ||
    typeof uploadKey !== 'string' ||
    !isPlausibleToken(uploadKey)
  ) {
    throw new UploadError('bad-response', 'Rangoli sent an unexpected response when starting the upload.');
  }

  const auth = { Authorization: `Bearer ${uploadKey}` };
  const uploadBase = `${base}/${uploadId}`;

  /** Retries transient failures. The server treats repeated requests as idempotent. */
  const sendWithRetry = async (
    url: string,
    init: RequestInit,
    failure: UploadErrorCode,
    what: string,
  ): Promise<Response> => {
    let lastDetail = 'network error';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfAborted();
      try {
        const response = await fetchFn(url, { ...init, ...(signal && { signal }) });
        if (response.ok) return response;
        lastDetail = `status ${response.status}`;
        if (!isRetryable(response.status)) break;
      } catch (error) {
        if (isAbort(error)) throw new UploadError('cancelled', 'Upload cancelled.');
      }
      if (attempt < maxAttempts) await sleep(500 * 2 ** (attempt - 1));
    }
    throw new UploadError(failure, `Could not ${what} (${lastDetail}). Create a new token and try again.`);
  };

  for (let index = 0; index < chunkCount; index += 1) {
    const offset = index * chunkBytes;
    const chunk = bytes.subarray(offset, offset + chunkBytes);
    await sendWithRetry(
      `${uploadBase}/chunks/${index}`,
      {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: chunk as BodyInit,
      },
      'chunk-failed',
      `send part ${index + 1} of ${chunkCount}`,
    );
    options.onProgress?.(Math.min(offset + chunk.byteLength, bytes.byteLength), bytes.byteLength);
  }

  const complete = await sendWithRetry(
    `${uploadBase}/complete`,
    { method: 'POST', headers: auth },
    'complete-failed',
    'finish the upload',
  );
  const result = await readJson(complete);
  const importId = result['importId'];
  if (typeof importId !== 'string' || !SAFE_SEGMENT.test(importId)) {
    throw new UploadError('bad-response', 'Rangoli sent an unexpected response when finishing the upload.');
  }
  return { importId };
}
