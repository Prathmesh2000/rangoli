/** Hosted mode: every render is a signed, one-use request to the separate render service. */
import { randomUUID } from 'node:crypto';
import type { Renderer } from './port.js';
import { sniffMime } from './limits.js';
import { inputUrl, sha256, signRequest, type RenderRequest } from './protocol.js';

const INLINE_IMAGE = /data:(image\/(?:png|jpeg|gif|webp|avif|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})/g;

/**
 * Lifts inline images out of the page into signed inputs, so they pass request interception and upload checks.
 * Each occurrence gets its own one-use URL; identical bytes travel once.
 */
export function hoistImages(html: string, secret: string, jti: string): { html: string; blobs: string[]; inputs: RenderRequest['inputs'] } {
  const blobs: string[] = [];
  const known = new Map<string, number>();
  const inputs: RenderRequest['inputs'] = [];
  const page = html.replace(INLINE_IMAGE, (_all, mime: string, b64: string) => {
    let blob = known.get(b64);
    if (blob === undefined) {
      blob = blobs.push(b64) - 1;
      known.set(b64, blob);
    }
    const url = inputUrl(secret, jti, inputs.length, mime, sha256(b64));
    inputs.push({ url, mime, blob });
    return url;
  });
  return { html: page, blobs, inputs };
}

export interface RemoteOptions {
  url: string;
  secret: string;
  timeoutMs?: number;
}

export function remoteRenderer(options: RemoteOptions): Renderer {
  const { secret } = options;
  const base = options.url.replace(/\/+$/, '');
  // long enough for a full queue of 30-second jobs ahead of this one
  const timeoutMs = options.timeoutMs ?? 160_000;

  const send = async <T>(request: RenderRequest): Promise<T> => {
    const body = Buffer.from(JSON.stringify(request));
    let res: Response;
    try {
      res = await fetch(`${base}/v1/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${signRequest(secret, request.jti, body)}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`The render service could not be reached: ${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`The render service refused this job (${res.status}): ${await res.text()}`);
    return (await res.json()) as T;
  };

  return {
    async shot(job) {
      const jti = randomUUID();
      const { html, blobs, inputs } = hoistImages(job.html, secret, jti);
      const r = await send<{ png: string }>({ jti, job: { kind: 'shot', ...job, html }, blobs, inputs });
      const png = Buffer.from(r.png, 'base64');
      if (sniffMime(png) !== 'image/png') throw new Error('The render service returned something other than a PNG');
      return png;
    },
    async edit(job) {
      const jti = randomUUID();
      const { image, ops, ...rest } = job;
      const r = await send<{ image: string; w: number; h: number }>({ jti, job: { kind: 'edit', ...rest, image: image.toString('base64'), ops: ops as unknown as Record<string, unknown>[] }, blobs: [], inputs: [] });
      const buf = Buffer.from(r.image, 'base64');
      if (sniffMime(buf) !== `image/${job.format}`) throw new Error(`The render service returned something other than ${job.format}`);
      return { buf, w: r.w, h: r.h };
    },
    close: async () => undefined,
  };
}
