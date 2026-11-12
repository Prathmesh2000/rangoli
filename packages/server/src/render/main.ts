#!/usr/bin/env node
/** Entry point of the render container. Imports nothing that can reach a database or AWS. */
import { createRenderService, forbiddenEnv } from './service.js';

const env = process.env;
const fail = (message: string): never => {
  console.error(`render: ${message}`);
  process.exit(1);
};

const forbidden = forbiddenEnv();
if (forbidden.length) fail(`refusing to start with credentials in the environment: ${forbidden.join(', ')}`);
const secret = env.RENDER_SIGNING_SECRET ?? '';
if (secret.length < 32) fail('RENDER_SIGNING_SECRET must be at least 32 characters');
delete env.RENDER_SIGNING_SECRET;

const service = createRenderService({
  secret,
  allowNoSandbox: env.RENDER_ALLOW_NO_SANDBOX === '1',
  restartAfter: Number(env.RENDER_RESTART_AFTER ?? 200),
});

try {
  await service.ready();
  const url = await service.listen(Number(env.PORT ?? 4500), env.HOST ?? '0.0.0.0');
  console.error(`render: listening on ${url}, Chromium sandbox ${service.stats.sandbox ? 'on' : 'OFF'}`);
} catch (e) {
  fail((e as Error).message);
}

const stop = () => service.close().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
