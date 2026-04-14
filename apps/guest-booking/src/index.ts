/**
 * Guest Booking — app-agent Worker entrypoint.
 *
 * Purpose: Manages guest bookings across Airbnb, VRBO, and Booking.com —
 * audits listing consistency across platforms and manages
 * overlapping-inventory availability using a graph-based
 * containment/conflict model.
 *
 * Routes:
 *   GET  /health    → { status: 'ok', agent: 'guest-booking' }
 *   GET  /*         → static assets from ./public
 *   POST /api/*     → Durable Object (REST API for the operator UI)
 *   POST /mcp       → JSON-RPC 2.0 MCP server (Claude custom tool integration)
 *
 * Queue consumer: drains `guest-booking-sync-queue`, one job per
 * platform block/unblock write.
 *
 * MCP auth: set MCP_HTTP_KEY secret via `wrangler secret put MCP_HTTP_KEY`,
 * then add Authorization: Bearer <MCP_HTTP_KEY> in Claude's connector settings.
 *
 * See ./SKILL.md for the full persona, tools, and non-goals.
 */

import type { BookingSyncJob, Env } from '../worker-configuration';
export { GuestBookingDO } from './durable-object.js';

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
  const expected = env.MCP_HTTP_KEY ?? '';
  if (!expected) return { ok: true };

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? new URL(request.url).searchParams.get('key') ?? '';

  if (token && token === expected) return { ok: true };
  return { ok: false, response: jsonResponse({ error: 'Unauthorized' }, 401) };
}

// ── MCP tool definitions ─────────────────────────────────────────────────────
// Stubs mirror the 7 tools documented in SKILL.md. Implementations land in
// ./skills/* once the Builder hands off.

const MCP_TOOLS = [
  {
    name: 'audit_listings',
    description:
      'Diff listing fields (price, terms, photos, descriptions, titles) across Airbnb/VRBO/Booking.com and return a structured divergence report.',
    inputSchema: {
      type: 'object',
      properties: {
        propertyId: { type: 'string', description: 'Optional property id to scope the audit.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sync_availability',
    description:
      'Given a booking event, walk the inventory graph and emit the full set of listings that must be blocked or unblocked, then enqueue the platform writes.',
    inputSchema: {
      type: 'object',
      properties: {
        listingNodeId: { type: 'string' },
        checkIn: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
        checkOut: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
        eventType: { type: 'string', enum: ['booked', 'cancelled', 'modified'] },
      },
      required: ['listingNodeId', 'checkIn', 'checkOut', 'eventType'],
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
        serverInfo: { name: 'guest-booking', version: '0.1.0' },
        instructions:
          'Audits listing consistency and manages overlapping-inventory availability across Airbnb, VRBO, and Booking.com.',
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const args = (params?.arguments ?? {}) as Record<string, unknown>;

    const doId = env.AGENT_DO.idFromName('global');
    const stub = env.AGENT_DO.get(doId);

    const doRequest = new Request(new URL(`/api/mcp/${name}`, originalRequest.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });

    const doResponse = await stub.fetch(doRequest);
    if (!doResponse.ok) {
      const text = await doResponse.text();
      return { jsonrpc: '2.0', id, error: { code: -32000, message: text } };
    }

    const result = (await doResponse.json()) as Record<string, unknown>;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result) }],
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
      return jsonResponse({ status: 'ok', agent: 'guest-booking' });
    }

    // MCP /mcp for Claude custom tool integration
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
        const out = await handleMcp(msg, env, request);
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

    // REST /api/* for the operator UI
    if (url.pathname.startsWith('/api/')) {
      const id = env.AGENT_DO.idFromName('global');
      const stub = env.AGENT_DO.get(id);
      return stub.fetch(request);
    }

    // Everything else is static UI.
    return env.ASSETS.fetch(request);
  },

  /**
   * Queue consumer: each message is a single platform block/unblock write
   * emitted by the inventory-graph resolver. Runs out-of-band from the
   * booking-event request so the DO can return quickly.
   */
  async queue(batch: MessageBatch<BookingSyncJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const id = env.AGENT_DO.idFromName('global');
        const stub = env.AGENT_DO.get(id);
        const res = await stub.fetch(
          new Request('https://do/api/sync/apply', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(message.body),
          }),
        );
        if (!res.ok) {
          message.retry();
        } else {
          message.ack();
        }
      } catch {
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, BookingSyncJob>;
