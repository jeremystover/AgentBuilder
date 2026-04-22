/**
 * Termination Documentation — headless agent Worker entrypoint.
 *
 * Routes:
 *   GET  /health  → { status: 'ok', agent: 'termination-documentation' }
 *   POST /chat    → REST chat passthrough (conversational, no tool state)
 *   POST /mcp     → JSON-RPC 2.0 MCP server (Claude custom tool integration)
 *
 * MCP auth: set MCP_HTTP_KEY secret via `wrangler secret put MCP_HTTP_KEY`,
 * then add Authorization: Bearer <MCP_HTTP_KEY> in Claude's connector settings.
 *
 * State lives in the TerminationDocumentationDO per sessionId. Every MCP
 * tool call must pass `sessionId` so the same case folder is used across
 * turns.
 *
 * See ./SKILL.md for the full persona, tools, and non-goals.
 */

import type { Env } from '../worker-configuration';
import { MCP_TOOLS } from './mcp/manifests.js';
export { TerminationDocumentationDO } from './durable-object.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── JSON-RPC 2.0 MCP handler ─────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SERVER_INFO = { name: 'termination-documentation', version: '0.2.0' };
const INSTRUCTIONS =
  'Helps a California employee document a possible wrongful-termination / retaliation / discrimination / harassment / wage-hour / leave claim. Interviews, builds a tailored evidence checklist, tracks collection. Not legal advice — the user should still retain counsel. Pass a stable `sessionId` argument on every tool call to keep state scoped to the same case.';

async function handleMcp(
  message: JsonRpcMessage,
  env: Env,
  originalRequest: Request,
): Promise<unknown> {
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
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
    };
  }

  if (method === 'tools/list') {
    // Each tool accepts sessionId alongside its declared inputSchema — we
    // inject it so Claude knows to pass it through without duplicating the
    // property across every manifest.
    const tools = MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: withSessionId(t.inputSchema),
    }));
    return { jsonrpc: '2.0', id, result: { tools } };
  }

  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const args = (params?.arguments ?? {}) as Record<string, unknown> & { sessionId?: string };

    const knownTool = MCP_TOOLS.find((t) => t.name === name);
    if (!knownTool) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    }

    const sessionId = typeof args.sessionId === 'string' && args.sessionId.length > 0
      ? args.sessionId
      : null;
    if (!sessionId) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message:
            '`sessionId` is required on every tool call so state is scoped to your case. Use a stable id per case (e.g. an email or UUID you keep across turns).',
        },
      };
    }

    const { sessionId: _omit, ...toolArgs } = args;

    const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(sessionId));
    const toolUrl = new URL(originalRequest.url);
    toolUrl.pathname = '/tool';
    const doResponse = await stub.fetch(
      new Request(toolUrl.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, args: toolArgs }),
      }),
    );

    const body = (await doResponse.json()) as
      | { ok: true; result: unknown }
      | { ok: false; error: string };

    if (!body.ok) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: body.error },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(body.result, null, 2) }],
        isError: false,
      },
    };
  }

  if (method === 'notifications/initialized') return null;

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function withSessionId(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const base = schema as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  return {
    ...base,
    properties: {
      sessionId: {
        type: 'string',
        description:
          'Stable id that scopes state to one case. Reuse the same value across every tool call for this user.',
      },
      ...(base.properties ?? {}),
    },
    required: Array.from(new Set(['sessionId', ...(base.required ?? [])])),
  };
}

// ── Worker ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ status: 'ok', agent: 'termination-documentation' });
    }

    // REST /chat for local testing with curl / chat.sh. No tool state.
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

    // MCP /mcp for Claude custom tool integration
    if (url.pathname === '/mcp' && request.method === 'POST') {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      let msg: JsonRpcMessage;
      try {
        msg = (await request.json()) as JsonRpcMessage;
      } catch {
        return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }

      try {
        const out = await handleMcp(msg, env, request);
        if (out === null) return new Response(null, { status: 204 });
        return jsonResponse(out);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message } });
      }
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
