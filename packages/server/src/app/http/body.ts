/** Reading request bodies. */
import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.js';

export const readBody = (req: IncomingMessage, limit = 2e6) =>
  new Promise<string>((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        rej(new HttpError(413, 'That is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    // decoded only once whole: a chunk can end in the middle of a multi-byte character
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });

export const parseJson = (raw: string) => {
  try {
    return JSON.parse(raw || '{}') as unknown;
  } catch {
    throw new HttpError(400, 'Malformed JSON');
  }
};

/** The whole body as JSON, before any schema has looked at it. */
export const readJson = async (req: IncomingMessage) => parseJson(await readBody(req));
