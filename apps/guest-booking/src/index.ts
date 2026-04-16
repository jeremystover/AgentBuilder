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

function requireAuth(request: Request, env: Env): { ok: true } | { ok: false; response: Response } {
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
    name: 'import_listings',
    description:
      'Import listings from Guesty (auto-fetched via API), Airbnb, or VRBO (manual entry). Returns the imported listings plus any existing listings from other platforms so you can ask the user which ones represent the same physical property and should be linked.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ['guesty', 'airbnb', 'vrbo'],
          description: 'The platform to import from.',
        },
        listings: {
          type: 'array',
          description:
            'Listing data for manual import (required for Airbnb/VRBO, optional for Guesty which can auto-fetch). Omit for Guesty to pull all listings from the API.',
          items: {
            type: 'object',
            properties: {
              externalId: { type: 'string', description: 'The listing ID on the platform.' },
              name: { type: 'string', description: 'Display name / nickname for this listing.' },
              title: { type: 'string', description: 'Listing headline / title.' },
              description: { type: 'string' },
              priceCents: { type: 'number', description: 'Nightly base price in cents.' },
              cleaningFeeCents: { type: 'number' },
              securityDepositCents: { type: 'number' },
              weeklyDiscountPct: {
                type: 'number',
                description: 'Weekly discount as a whole number (e.g. 10 = 10%).',
              },
              monthlyDiscountPct: {
                type: 'number',
                description: 'Monthly discount as a whole number.',
              },
              minNights: { type: 'number' },
              maxNights: { type: 'number' },
              instantBook: { type: 'boolean' },
              cancellationPolicy: { type: 'string' },
              maxGuests: { type: 'number' },
              bedrooms: { type: 'number' },
              bathrooms: { type: 'number' },
              beds: { type: 'number' },
              checkInTime: { type: 'string', description: 'e.g. "15:00" or "3:00 PM".' },
              checkOutTime: { type: 'string', description: 'e.g. "11:00" or "11:00 AM".' },
              photoUrls: { type: 'array', items: { type: 'string' }, description: 'Photo URLs.' },
              amenities: { type: 'array', items: { type: 'string' } },
              houseRules: { type: 'string' },
              petPolicy: { type: 'string' },
              propertyType: { type: 'string', description: 'e.g. house, apartment, cabin.' },
            },
            required: ['externalId', 'name'],
          },
        },
      },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  {
    name: 'link_listings',
    description:
      'Link listing nodes from different platforms that represent the same physical property. This groups them for cross-platform audit comparison and creates conflicts_with edges so availability sync blocks across platforms.',
    inputSchema: {
      type: 'object',
      properties: {
        listingNodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of listing node IDs (at least 2) that represent the same property.',
        },
        propertyLabel: {
          type: 'string',
          description: 'Optional human-readable label for this property group.',
        },
      },
      required: ['listingNodeIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'audit_listings',
    description:
      'Compare listing configuration across platforms for linked properties. Returns a field-by-field divergence report showing what is out of sync (photos, instant book, pricing, discounts, description, amenities, policies, etc.) as a table with the current value on each platform.',
    inputSchema: {
      type: 'object',
      properties: {
        propertyId: {
          type: 'string',
          description: 'Property group ID to audit. Omit to audit all linked properties.',
        },
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
