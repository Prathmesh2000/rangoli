/** Errors a handler throws, and the one place they become responses. */
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { logger } from '../../telemetry/log.js';
import { dbErrorMessage } from '../db.js';
import type { Json } from './context.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: object) {
    super(message);
  }
}

export const notFound = () => new HttpError(404, 'Not found');

export const zodMessage = (e: z.ZodError) => e.issues[0]?.message ?? 'That value is not valid.';

/** Never echoes database errors: only known ones get a message of their own. */
export function sendError(e: unknown, res: ServerResponse, json: Json): void {
  if (res.headersSent) return void res.end();
  if (e instanceof HttpError) return json(e.status, { error: e.message, ...e.extra });
  if (e instanceof z.ZodError) return json(400, { error: zodMessage(e) });
  const known = dbErrorMessage(e);
  if (known) return json(known.status, { error: known.message });
  logger.error('request failed', { err: e });
  json(500, { error: 'Something went wrong on the server. Try again.' }); // never echo database errors
}
