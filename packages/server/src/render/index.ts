/** Picks the Renderer for this process. The choice is fixed configuration, never per-tenant state. */
import { inProcessRenderer } from './in-process.js';
import type { Renderer } from './port.js';
import { remoteRenderer } from './remote.js';

export type { EditJob, EditResult, Renderer, ShotJob } from './port.js';

/** Any of these means database credentials live in this process, so Chromium must not. */
const DATABASE_SECRETS = ['DB_OWNER_PASSWORD', 'DB_APP_PASSWORD', 'DATABASE_URL', 'APP_DATABASE_URL'];

export function createRenderer(env: NodeJS.ProcessEnv = process.env): Renderer {
  if (env.RENDER_SERVICE_URL) {
    if (!env.RENDER_SIGNING_SECRET || env.RENDER_SIGNING_SECRET.length < 32) throw new Error('RENDER_SERVICE_URL needs RENDER_SIGNING_SECRET of at least 32 characters');
    return remoteRenderer({ url: env.RENDER_SERVICE_URL, secret: env.RENDER_SIGNING_SECRET });
  }
  // RANGOLI_RENDERER=in-process is for a developer's own database on their own machine
  if (env.RANGOLI_RENDERER !== 'in-process' && DATABASE_SECRETS.some((name) => env[name])) {
    throw new Error('Rendering is off: this process holds database credentials, so Chromium cannot run here. Set RENDER_SERVICE_URL and RENDER_SIGNING_SECRET to use the render service.');
  }
  return inProcessRenderer();
}

let current: Renderer | undefined;

export function renderer(): Renderer {
  current ??= createRenderer();
  return current;
}

export async function closeRenderer(): Promise<void> {
  await current?.close();
  current = undefined;
}
