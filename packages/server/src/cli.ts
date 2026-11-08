#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { applyRdl, formatLint, lint, renderDocument, serializeRdl } from '@rangoli/engine';
import { startPreview } from './http.js';
import { createMcpServer } from './mcp.js';
import { Session } from './session.js';

const HELP = `rangoli — agent-first design tool

Usage:
  rangoli init <dir.rangoli> [--name "My App"] [--brand #2a6fb0]   create a document
  rangoli mcp <dir.rangoli> [--port 4400] [--no-preview] [--share]  MCP server on stdio for agents (+ editor)
  rangoli serve <dir.rangoli> [--port 4400] [--share]               editor + preview only (browser)
      --share   listen on the local network and print invite links (editor / reviewer / viewer)
  rangoli apply <dir.rangoli> <script.rdl>                          apply an RDL script
  rangoli show <dir.rangoli> [--outline]                            print the document as RDL
  rangoli lint <dir.rangoli>                                        lint (exit 1 on P0/P1)
  rangoli render <dir.rangoli> -o out.html [--mode dark]            standalone HTML

Connect Claude Code:
  claude mcp add rangoli -- node <path>/packages/server/dist/cli.js mcp <abs path to dir.rangoli>`;

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
  if (!target) throw new Error(`Missing <dir.rangoli>\n\n${HELP}`);

  switch (cmd) {
    case 'init': {
      const brand = flag(rest, '--brand');
      const s = await Session.create(target, flag(rest, '--name') ?? 'Untitled', brand ? { brand } : {});
      log(`Created ${s.dir}`);
      return;
    }
    case 'mcp': {
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
      await writeFile(resolve(out), renderDocument(session.doc, { mode: flag(rest, '--mode') }));
      log(`Wrote ${resolve(out)}`);
      return;
    }
    default:
      throw new Error(`Unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
