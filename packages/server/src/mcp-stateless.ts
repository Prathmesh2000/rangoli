/**
 * Stateless MCP over HTTP (specification 2026-07-28, SEP-2575 and SEP-2567).
 *
 * There is no `initialize` handshake to depend on and no Mcp-Session-Id: every POST stands alone, carries its
 * protocol version in the `MCP-Protocol-Version` header or in `_meta`, and is authorized afresh. Anything that
 * must survive between calls is an explicit handle passed as an ordinary argument (`project` from
 * project_open; a run is looked up by the token that opened it). `server/discover` advertises versions.
 *
 * Clients on 2025-xx revisions still work: `initialize` is answered (and simply not required), and results only
 * gain the 2026 fields (`resultType`, `_meta` server identity, list cache hints) when the caller speaks 2026.
 * The SDK in this repository predates 2026-07-28, so this layer is written against the specification directly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

export const STATELESS_PROTOCOL_VERSION = '2026-07-28';
export const PROTOCOL_VERSIONS = [STATELESS_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
/** error codes from the 2026-07-28 allocation */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
  [k: string]: unknown;
}

/** What answers the stateless endpoint: a fixed tool list and one call at a time. */
export interface StatelessTarget {
  info: { name: string; version: string };
  instructions?: string;
  listTools(): Promise<ToolDef[]>;
  /** null when no such tool exists */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null>;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { _meta?: Record<string, unknown>; name?: string; arguments?: Record<string, unknown>; protocolVersion?: string; [k: string]: unknown };
}

/** True when a request cannot belong to an SDK session: 2026 traffic, or a sessionless non-initialize call. */
export function isStatelessRequest(req: IncomingMessage, body: unknown): boolean {
  if (req.headers['mcp-session-id']) return false;
  const header = req.headers['mcp-protocol-version'];
  if (header === STATELESS_PROTOCOL_VERSION) return true;
  const msg = body as RpcRequest | null;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  if (msg.method === 'server/discover') return true;
  if (msg.params?._meta?.[META_VERSION]) return true;
  return msg.method !== 'initialize';
}

/** A registered McpServer as a stateless target: each use links a fresh in-memory client, then closes it. */
export async function serverTarget(make: () => McpServer | Promise<McpServer>, info: StatelessTarget['info'], instructions?: string): Promise<StatelessTarget & { close(): Promise<void> }> {
  const server = await make();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'rangoli-stateless', version: '1' });
  await client.connect(clientSide);
  return {
    info,
    instructions,
    listTools: async () => (await client.listTools()).tools as ToolDef[],
    callTool: async (name, args) => {
      try {
        const out = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;
        // the SDK reports an unknown tool as an error result; the protocol answer is Invalid Params
        const first = out.content[0] as { text?: string } | undefined;
        if (out.isError && new RegExp(`^MCP error -32602: Tool ${name.replace(/[^\w-]/g, '')} not found`).test(first?.text ?? '')) return null;
        return out;
      } catch (e) {
        if (/not found/i.test(e instanceof Error ? e.message : '')) return null;
        throw e;
      }
    },
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) return void res.writeHead(status).end();
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
};

/**
 * Answer one stateless MCP POST. GET (the old listening stream) is refused: change notifications are not
 * offered, so there is nothing to listen to.
 */
export async function handleStateless(req: IncomingMessage, res: ServerResponse, body: unknown, target: StatelessTarget | (() => Promise<StatelessTarget>)): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this endpoint is stateless; send each request as a POST.' }, id: null });
  if (Array.isArray(body)) return send(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Batches are not supported' }, id: null });
  const msg = body as RpcRequest | null;
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return send(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' }, id: null });
  // a notification (no id) needs no answer
  if (msg.id === undefined || msg.id === null) return send(res, 202);
  const id = msg.id;
  const header = req.headers['mcp-protocol-version'];
  const requested = (msg.params?._meta?.[META_VERSION] as string | undefined) ?? (typeof header === 'string' ? header : undefined);
  if (requested && !PROTOCOL_VERSIONS.includes(requested) && msg.method !== 'initialize') {
    return send(res, 200, { jsonrpc: '2.0', id, error: { code: UNSUPPORTED_PROTOCOL_VERSION, message: `Unsupported protocol version ${requested}`, data: { supported: PROTOCOL_VERSIONS } } });
  }
  const modern = requested === STATELESS_PROTOCOL_VERSION || msg.method === 'server/discover';
  const t = typeof target === 'function' ? await target() : target;
  const ok = (result: Record<string, unknown>) => send(res, 200, { jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta as object | undefined), [META_SERVER]: t.info } } : result });
  const fail = (code: number, message: string) => send(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  const capabilities = { tools: { listChanged: false } };
  switch (msg.method) {
    case 'server/discover':
      return ok({ supportedVersions: PROTOCOL_VERSIONS, capabilities, serverInfo: t.info, ...(t.instructions ? { instructions: t.instructions } : {}) });
    case 'initialize': {
      // still answered for 2025 clients; nothing is remembered about it
      const asked = msg.params?.protocolVersion;
      const version = typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0]!;
      return send(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities, serverInfo: t.info, ...(t.instructions ? { instructions: t.instructions } : {}) } });
    }
    case 'ping':
      return ok({});
    case 'tools/list': {
      // the same for every caller and in a fixed order, so clients may cache it
      const tools = [...(await t.listTools())].sort((a, b) => a.name.localeCompare(b.name));
      return ok({ tools, ...(modern ? { ttlMs: 300_000, cacheScope: 'private' } : {}) });
    }
    case 'tools/call': {
      const name = msg.params?.name;
      if (typeof name !== 'string') return fail(-32602, 'tools/call needs a tool name');
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      try {
        const out = await t.callTool(name, args);
        if (!out) return fail(-32602, `Tool ${name} not found`);
        return ok(out as Record<string, unknown>);
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
