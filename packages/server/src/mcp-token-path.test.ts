import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from './mcp.js';
import { Session } from './session.js';

describe('token_set over MCP', () => {
  let dir: string;
  let client: Client;
  let session: Session;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rangoli-mcp-token-'));
    session = await Session.create(join(dir, 'd.rangoli'), 'Tokens');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createMcpServer(session, { author: 'agent:test' }).connect(serverTransport);
    client = new Client({ name: 'token-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client?.close();
    await session?.flush();
    await rm(dir, { recursive: true, force: true });
  });

  const callTokenSet = (path: string, value: string) => client.callTool({ name: 'token_set', arguments: { path, value } }) as Promise<{ isError?: boolean; content: { text: string }[] }>;

  it.each(['__proto__.x', 'color.__proto__.x', 'constructor.prototype.x'])('rejects %s and leaves Object.prototype clean', async (path) => {
    const before = JSON.stringify(session.doc.data.tokens);
    const r = await callTokenSet(path, 'polluted');
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/reserved/i);
    expect(({} as { x?: unknown }).x).toBeUndefined();
    expect(JSON.stringify(session.doc.data.tokens)).toBe(before);
  });

  it('still sets an ordinary token', async () => {
    const r = await callTokenSet('color.neutral.50', '#fafafa');
    expect(r.isError ?? false).toBe(false);
    expect((session.doc.data.tokens.color as Record<string, Record<string, { $value: unknown }>>).neutral![50]!.$value).toBe('#fafafa');
  });
});
