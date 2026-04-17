/**
 * World Monitor — headless agent Worker entrypoint.
 *
 * Surfaces live situational-awareness data (markets, news, climate, government, etc.)
 * as 8 coarse MCP tools. Each tool takes an `operation` enum + `params` object and
 * dispatches internally to either:
 *   - a proxy call to worldmonitor.app  (default — 21 upstream services)
 *   - a direct call to the underlying provider (SEC EDGAR in v1; more to follow)
 *
 * Routes:
 *   GET  /health  → { status, agent, wiredCategories }
 *   POST /chat    → { message, sessionId? } (REST, for curl / chat.sh)
 *   POST /mcp     → JSON-RPC 2.0 MCP server
 *
 * MCP auth: set MCP_HTTP_KEY via `wrangler secret put MCP_HTTP_KEY`.
 * KV cache (optional): bind WM_CACHE in wrangler.toml — see SKILL.md.
 */

import { UpstreamError } from './client.js';
import { dispatch } from './dispatcher.js';
import { MCP_TOOLS } from './mcp-tools.js';
import type { CoarseCategory } from './registry/types.js';
import type { Env } from '../worker-configuration';

export { WorldMonitorDO } from './durable-object.js';

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requireAuth(
  request: Request,
  env: Env,
): { ok: true } | { ok: false; response: Response } {
  const expected = (env as unknown as Record<string, string>).MCP_HTTP_KEY ?? '';
  if (!expected) return { ok: true };

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? new URL(request.url).searchParams.get('key') ?? '';

  if (token && token === expected) return { ok: true };
  return { ok: false, response: jsonResponse({ error: 'Unauthorized' }, 401) };
}

const CATEGORIES: ReadonlySet<CoarseCategory> = new Set([
  'markets',
  'geopolitics',
  'news',
  'climate',
  'supply_chain',
  'cyber_infra',
  'government',
  'predictions',
]);

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function handleMcp(message: JsonRpcMessage, env: Env): Promise<unknown> {
  const { id, method, params } = message;

  if (!method) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'world-monitor', version: '0.1.0' },
        instructions:
          'Situational-awareness data from markets, geopolitics, news, climate, supply chain, cyber, government, and prediction markets. Call a coarse tool with {operation, params}; see the operation enum for available endpoints.',
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    if (!CATEGORIES.has(name as CoarseCategory)) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    }

    const args = (params?.arguments ?? {}) as { operation?: string; params?: Record<string, unknown> };
    if (!args.operation) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: '`operation` is required' } };
    }

    try {
      const result = await dispatch(
        env as unknown as Parameters<typeof dispatch>[0],
        name as CoarseCategory,
        args.operation,
        args.params ?? {},
      );
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        },
      };
    } catch (err: unknown) {
      const status = err instanceof UpstreamError ? err.status : 500;
      const msg = err instanceof Error ? err.message : String(err);
      return { jsonrpc: '2.0', id, error: { code: -32000 - status, message: msg } };
    }
  }

  if (method === 'notifications/initialized') return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        agent: 'world-monitor',
        wiredCategories: ['markets', 'news', 'climate', 'government'],
        cache: (env as unknown as { WM_CACHE?: unknown }).WM_CACHE ? 'enabled' : 'disabled',
      });
    }

    if (url.pathname === '/chat' && request.method === 'POST') {
      let sessionId: string | null = null;
      const cloned = request.clone();
      try {
        const body = (await cloned.json()) as { sessionId?: string };
        sessionId = body.sessionId ?? null;
      } catch {
        // DO will return 400
      }
      const doKey = sessionId ?? crypto.randomUUID();
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(doKey));
      return stub.fetch(request);
    }

    if (url.pathname === '/mcp' && request.method === 'POST') {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      let msg: JsonRpcMessage;
      try {
        msg = (await request.json()) as JsonRpcMessage;
      } catch {
        return jsonResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }

      try {
        const out = await handleMcp(msg, env);
        if (out === null) return new Response(null, { status: 204 });
        return jsonResponse(out);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({
          jsonrpc: '2.0',
          id: msg.id ?? null,
          error: { code: -32000, message },
        });
      }
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
