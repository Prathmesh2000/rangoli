/** What a signed-in route handler is given, and the app-wide services every module shares. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import type { Database, Q } from '../db.js';
import type { IdentityConfig } from '../identity/config.js';
import type { Sessions, StepUp } from '../identity/sessions.js';
import type { BlobStore, Mailer } from '../infra.js';

export interface User {
  id: string;
  email: string;
  name: string;
}

export type Json = (status: number, body: unknown) => void;

/** Runs fn in one transaction as that person (null: no one), so RLS decides what it sees. */
export type As = <T>(id: string | null, fn: (q: Q) => Promise<T>) => Promise<T>;

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: User;
  p: string[];
  json: Json;
  body<T>(schema: z.ZodType<T>): Promise<T>;
  as<T>(fn: (q: Q) => Promise<T>): Promise<T>;
}

export type Handler = (c: Ctx) => Promise<void>;

/** A route that runs before anyone is signed in. Returns false when the request is not its own. */
export type PublicRoute = (req: IncomingMessage, res: ServerResponse, url: URL, json: Json) => Promise<boolean>;

export interface AppCore {
  db: Database;
  blobs?: BlobStore;
  mail: Mailer;
  publicUrl?: string;
  inviteOnly?: boolean;
  as: As;
  /** Mail never decides whether a request succeeded. */
  notify(to: string[], subject: string, text: string): void;
  /** Where links in mail point: the public URL, or the host the request came to. */
  originOf(req: IncomingMessage): string;
  identity: IdentityConfig;
  /** Sessions; rotate one when what its person may do changes (a role change, say). */
  sessions: Sessions;
  /**
   * Proof the person is at the keyboard now, for approvals: verified email, MFA if they are a named approver,
   * and a fresh password or code within 5 minutes. Throws a 403 the app turns into the right prompt.
   */
  stepUp: StepUp;
  /** The client's address, honouring only the configured number of trusted proxies. */
  clientIp(req: IncomingMessage): string;
}
