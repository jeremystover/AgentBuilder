/**
 * AgentBuilder — the meta-agent.
 *
 * Routes:
 *   GET  /health  → { status: 'ok', ... }
 *   POST /chat    → { message, sessionId?, persona? } (REST, for curl / chat.sh)
 *   POST /mcp     → JSON-RPC 2.0 MCP server (Claude custom tool integration)
 *
 * MCP auth: set MCP_HTTP_KEY secret, then add
 *   Authorization: Bearer <MCP_HTTP_KEY>
 * in Claude's custom tool connector settings.
 *
 * Each /chat session pins to a single Durable Object keyed by sessionId so
 * conversation history stays consistent across turns.
 */

import type { Env } from '../worker-configuration';
export { AgentBuilderDO } from './durable-object.js';

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
  if (!expected) return { ok: true }; // no key configured → open (dev)

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? new URL(request.url).searchParams.get('key') ?? '';

  if (token && token === expected) return { ok: true };
  return { ok: false, response: jsonResponse({ error: 'Unauthorized' }, 401) };
}

// ── MCP tool definitions ─────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'chat',
    description:
      'Send a message to the AgentBuilder meta-agent. ' +
      'The Architect persona designs new agents or advises on extending existing ones. ' +
      'Pass the returned sessionId back on follow-up turns to continue the conversation. ' +
      'Omit sessionId to start a new session.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Your message to the agent.' },
        sessionId: {
          type: 'string',
          description: 'Conversation session id. Omit to start a new session.',
        },
        persona: {
          type: 'string',
          enum: ['architect', 'builder', 'fleet-manager'],
          description: 'Which persona to invoke. Defaults to architect.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

// ── JSON-RPC 2.0 MCP handler ─────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

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
        serverInfo: { name: 'agent-builder', version: '0.2.0' },
        instructions:
          'AgentBuilder meta-agent. Use the chat tool to design, extend, or manage agents ' +
          'in your fleet. Always pass the returned sessionId back to continue a conversation.',
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    if (name !== 'chat') {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
    }

    const args = (params?.arguments ?? {}) as {
      message?: string;
      sessionId?: string;
      persona?: string;
    };

    if (!args.message) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: '`message` is required' } };
    }

    // Route to the Durable Object exactly like /chat does
    const doKey = args.sessionId ?? crypto.randomUUID();
    const doId = env.AGENT_BUILDER_DO.idFromName(doKey);
    const stub = env.AGENT_BUILDER_DO.get(doId);

    const doRequest = new Request(originalRequest.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: args.message,
        sessionId: doKey,
        persona: args.persona ?? 'architect',
      }),
    });

    const doResponse = await stub.fetch(doRequest);
    if (!doResponse.ok) {
      const text = await doResponse.text();
      return { jsonrpc: '2.0', id, error: { code: -32000, message: text } };
    }

    const result = (await doResponse.json()) as {
      sessionId: string;
      persona: string;
      reply: string;
      handoffTo?: string;
      iterations: number;
      usage: Record<string, number>;
    };

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: result.reply,
          },
          {
            type: 'text',
            text: JSON.stringify({
              sessionId: result.sessionId,
              persona: result.persona,
              handoffTo: result.handoffTo,
              iterations: result.iterations,
              usage: result.usage,
            }),
          },
        ],
      },
    };
  }

  if (method === 'notifications/initialized') return null;

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Worker ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        agent: 'agent-builder',
        phase: 2,
        personas: ['architect', 'builder', 'fleet-manager'],
      });
    }

    // ── REST /chat (for curl / chat.sh) ─────────────────────────────────────
    if (url.pathname === '/chat' && request.method === 'POST') {
      let sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        const cloned = request.clone();
        try {
          const body = (await cloned.json()) as { sessionId?: string };
          sessionId = body.sessionId ?? null;
        } catch {
          // DO will return 400 for malformed bodies
        }
      }

      const doKey = sessionId ?? crypto.randomUUID();
      const id = env.AGENT_BUILDER_DO.idFromName(doKey);
      const stub = env.AGENT_BUILDER_DO.get(id);
      return stub.fetch(request);
    }

    // ── MCP /mcp (Claude custom tool integration) ────────────────────────────
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
