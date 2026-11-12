/** Response headers, CSP, cookies and the same-origin rule for writes. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Json } from './context.js';
import { HttpError } from './errors.js';

export const APP_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Set on every response. */
export const setBaseHeaders = (res: ServerResponse) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer'); // invite tokens live in URLs
};

export const jsonResponder = (res: ServerResponse): Json => (status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** Decodes a cookie value, leaving it as sent when it is not valid percent-encoding. */
const decodeCookie = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** The request's cookies. A malformed one is kept raw (and so matches nothing), never a 500. */
export const cookies = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = decodeCookie(part.slice(i + 1).trim());
  }
  return out;
};

/** Adds a Set-Cookie header without replacing one already set on this response. */
export const appendCookie = (res: ServerResponse, cookie: string) => {
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev === undefined ? [] : [String(prev)]), cookie]);
};

export const sameOrigin = (req: IncomingMessage) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
};

/** Writes to /api/ must come from this origin and carry JSON. */
export const assertApiWrite = (req: IncomingMessage) => {
  if (req.method !== 'GET' && (!sameOrigin(req) || !(req.headers['content-type'] ?? '').startsWith('application/json'))) throw new HttpError(403, 'Cross-origin or non-JSON write rejected');
};

export const originOf = (publicUrl: string | undefined, req: IncomingMessage) => publicUrl?.replace(/\/$/, '') ?? `http://${req.headers.host}`;
