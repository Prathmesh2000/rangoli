#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findRunning, lockPath } from './lock.js';
import { applyRdl, formatLint, lint, renderDocument, serializeRdl } from '@rangoli/engine';
import { startPreview } from './http.js';
import { createMcpServer } from './mcp.js';
import { Session } from './session.js';
import { createLogger, logger } from './telemetry/log.js';
import { startRuntimeMetrics } from './telemetry/metrics.js';

const HELP = `rangoli — agent-first design tool

Usage:
  rangoli init <dir.rangoli> [--name "My App"] [--brand #2a6fb0]   create a document
  rangoli mcp <dir.rangoli> [--port 4400] [--no-preview] [--share]  MCP server on stdio for agents (+ editor)
  rangoli serve <dir.rangoli> [--port 4400] [--share]               editor + preview only (browser)
      --share   listen on the local network and print invite links (editor / reviewer / viewer)
  rangoli apply <dir.rangoli> <script.rdl>                          apply an RDL script
  rangoli show <dir.rangoli> [--outline]                            print the document as RDL
  rangoli app [--data ./rangoli-data] [--port 4400] [--host 127.0.0.1] [--invite-only]
                                                                    the team app: orgs, projects, roles, lifecycle
      DATABASE_URL       Postgres owner connection, migrates on start (default: embedded database in --data)
      APP_DATABASE_URL   Postgres connection logging in as rangoli_login. Alone, it never migrates (run rangoli migrate)
      RANGOLI_PUBLIC_URL https://… when behind a proxy (Secure cookies, absolute invite links)
      DB_HOST, DB_PORT, DB_NAME, DB_APP_PASSWORD, DB_SSL_CA   hosted login as separate values (ECS); never migrates
      S3_BUCKET          store images in S3 instead of Postgres
      SES_FROM           send invites, reviews and password resets through SES
      LOG_LEVEL          debug, info, warn or error (default: info in production, otherwise warn)
  rangoli migrate                                                   apply pending migrations as the schema owner, then exit
      DATABASE_URL, or DB_HOST + DB_OWNER_USER + DB_OWNER_PASSWORD (DB_APP_PASSWORD also sets rangoli_login's password)
  rangoli lint <dir.rangoli>                                        lint (exit 1 on P0/P1)
  rangoli render <dir.rangoli> -o out.html [--mode dark]            standalone HTML

Connect Claude Code:
  claude mcp add rangoli -- node <path>/packages/server/dist/cli.js mcp <abs path to dir.rangoli>
  (if the editor is already running for that document, the agent attaches to it — one process, one history)
Connect over HTTP (e.g. Cursor):  http://127.0.0.1:4400/mcp   (this machine only)`;

/** Pipe JSON-RPC between this process's stdio (the agent) and the running server's /mcp endpoint. */
async function bridge(url: string, log: (...m: unknown[]) => void): Promise<void> {
  const stdio = new StdioServerTransport();
  const http = new StreamableHTTPClientTransport(new URL(url));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void http.close().finally(() => process.exit(0));
  };
  stdio.onmessage = (m) => {
    http.send(m).catch((e: unknown) => log('[rangoli] bridge send failed:', e instanceof Error ? e.message : e));
  };
  http.onmessage = (m) => {
    void stdio.send(m);
  };
  http.onerror = (e) => log('[rangoli] bridge error:', e.message);
  stdio.onclose = shutdown;
  http.onclose = shutdown;
  process.stdin.on('close', shutdown);
  await http.start();
  await stdio.start();
}

/** Create one invite token per role and print LAN links (owner shares them with teammates). */
function printInvites(session: Session, lanUrls: string[], log: (...m: unknown[]) => void) {
  if (!lanUrls.length) {
    log('[rangoli] --share: no network interface found; only this machine can connect.');
    return;
  }
  log('[rangoli] Invite links (anyone with a link gets that role until the server stops):');
  for (const role of ['editor', 'reviewer', 'viewer'] as const) {
    const token = session.createShareToken(role);
    log(`  ${role.padEnd(8)} ${lanUrls.map((u) => `${u}editor/?t=${token}`).join('  ')}`);
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, target, ...rest] = process.argv.slice(2);
  const log = (...m: unknown[]) => console.error(...m); // stdout is reserved for MCP
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (cmd === 'migrate') {
    const { migrationTarget, runMigrationTask } = await import('./app/db.js');
    const target = migrationTarget(process.env);
    if (!target) throw new Error('Set DATABASE_URL, or DB_HOST, DB_OWNER_USER and DB_OWNER_PASSWORD. The embedded database migrates itself when the app starts.');
    const applied = await runMigrationTask(target);
    createLogger({ level: 'info' }).info('migrations complete', { applied });
    return;
  }
  if (cmd === 'app') {
    const args = process.argv.slice(3);
    const { appDatabaseOptions, openDatabase } = await import('./app/db.js');
    const { startApp } = await import('./app/server.js');
    const { s3Blobs, sesMailer } = await import('./app/infra.js');
    const env = process.env;
    if (env.DB_HOST && env.DB_OWNER_PASSWORD) logger.warn('DB_OWNER_PASSWORD is set but the app does not use it; remove it from this environment');
    const db = await openDatabase(appDatabaseOptions(env, resolve(flag(args, '--data') ?? 'rangoli-data')));
    await db.singleton();
    const blobs = env.S3_BUCKET ? await s3Blobs({ bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT }) : undefined;
    const mail = env.SES_FROM ? await sesMailer(env.SES_FROM) : undefined;
    const app = await startApp({ db, blobs, mail, port: Number(env.PORT ?? flag(args, '--port') ?? 4400), host: flag(args, '--host') ?? env.HOST ?? '127.0.0.1', publicUrl: env.RANGOLI_PUBLIC_URL, inviteOnly: args.includes('--invite-only') || env.RANGOLI_INVITE_ONLY === '1' });
    const stopMetrics = startRuntimeMetrics();
    if (env.NODE_ENV === 'production') logger.info('app started', { url: env.RANGOLI_PUBLIC_URL ?? app.url, driver: db.driver, images: blobs ? 's3' : 'database', mail: mail ? 'ses' : 'log' });
    else log(`Rangoli: ${env.RANGOLI_PUBLIC_URL ?? app.url}  (${db.driver}, images in ${blobs ? 's3' : 'database'}, mail ${mail ? 'ses' : 'to log'}, Ctrl+C to stop)`);
    const stop = async () => {
      stopMetrics();
      await app.close();
      await db.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  if (!target) throw new Error(`Missing <dir.rangoli>\n\n${HELP}`);

  switch (cmd) {
    case 'init': {
      const brand = flag(rest, '--brand');
      const s = await Session.create(target, flag(rest, '--name') ?? 'Untitled', brand ? { brand } : {});
      log(`Created ${s.dir}`);
      return;
    }
    case 'mcp': {
      // If an editor/server already has this document open, become a thin stdio↔HTTP bridge to it.
      const running = await findRunning(target);
      if (running) {
        await bridge(`${running.url}mcp`, log);
        log(`[rangoli] attached to running server ${running.url} (editor: ${running.url}editor/)`);
        return;
      }
      const session = await Session.openOrCreate(target);
      let previewUrl: string | undefined;
      if (!rest.includes('--no-preview')) {
        const p = await startPreview(session, { port: Number(flag(rest, '--port') ?? 4400), share: rest.includes('--share') });
        previewUrl = p.url;
        log(`[rangoli] editor ${p.url}editor/`);
        if (rest.includes('--share')) printInvites(session, p.lanUrls, log);
      }
      const server = createMcpServer(session, { previewUrl, author: 'agent' });
      await server.connect(new StdioServerTransport());
      session.touchPresence({ clientId: 'agent', name: 'Agent', role: 'agent', selection: [] });
      log(`[rangoli] MCP ready for ${session.dir}`);
      const shutdown = async () => {
        await session.flush();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.stdin.on('close', shutdown);
      return;
    }
    case 'serve': {
      const running = await findRunning(target);
      if (running) {
        log(`This document is already open in another Rangoli process: ${running.url}editor/ (pid ${running.pid}).\nIf that process is gone, delete ${lockPath(target)} and try again.`);
        process.exitCode = 1;
        return;
      }
      const session = await Session.openOrCreate(target);
      const p = await startPreview(session, { port: Number(flag(rest, '--port') ?? 4400), share: rest.includes('--share') });
      log(`Rangoli editor: ${p.url}editor/   preview: ${p.url}  (Ctrl+C to stop)`);
      if (rest.includes('--share')) printInvites(session, p.lanUrls, log);
      const stop = async () => {
        await session.flush();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'apply': {
      const file = rest[0];
      if (!file) throw new Error('Missing <script.rdl>');
      const session = await Session.open(target);
      const res = applyRdl(session.doc, await readFile(file, 'utf8'), { author: 'cli', label: file });
      await session.flush();
      log(`Applied. created: ${res.created.join(' ') || '-'}`);
      const issues = lint(session.doc).filter((i) => i.severity !== 'P3');
      if (issues.length) log(formatLint(issues));
      return;
    }
    case 'show': {
      const session = await Session.open(target);
      console.log(serializeRdl(session.doc, { detail: rest.includes('--outline') ? 'outline' : 'compact' }));
      return;
    }
    case 'lint': {
      const session = await Session.open(target);
      const issues = lint(session.doc);
      console.log(formatLint(issues));
      if (issues.some((i) => i.severity === 'P0' || i.severity === 'P1')) process.exitCode = 1;
      return;
    }
    case 'render': {
      const out = flag(rest, '-o') ?? 'out.html';
      const session = await Session.open(target);
      await writeFile(resolve(out), renderDocument(session.doc, { mode: flag(rest, '--mode'), scripts: true }));
      log(`Wrote ${resolve(out)}`);
      return;
    }
    default:
      throw new Error(`Unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((e) => {
  if (['app', 'migrate'].includes(process.argv[2] ?? '')) logger.error('startup failed', { err: e });
  else console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
