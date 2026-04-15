/**
 * MCP JSON-RPC 2.0 handler for the guest-booking worker.
 *
 * This is a thin wrapper over the REST API the admin SPA already uses.
 * Each MCP tool synthesizes a Request and dispatches it through the Hono
 * app via `app.request(path, init, env)` so there's no parallel code path
 * to drift out of sync with the REST layer.
 *
 * Tool surface (tracks the guest-booking registry entry):
 *   - list_properties:    GET  /api/properties
 *   - list_units:         GET  /api/units
 *   - list_listings:      GET  /api/listings
 *   - list_platforms:     GET  /api/platforms
 *   - list_bookings:      GET  /api/bookings?unit_id=&from=&to=
 *   - check_availability: GET  /api/availability?unit_id=&start=&end=
 *   - pull_all_calendars: POST /api/sync/pull-all
 *   - sync_log:           GET  /api/sync-log
 *
 * Adding a tool later = add an entry to MCP_TOOLS and a case in
 * dispatchTool. Do NOT add new business logic here — extend the REST
 * handler and proxy to it.
 */

import type { Hono } from "hono";
import type { Env } from "./types";

type AppEnv = { Bindings: Env };
export type GuestBookingHono = Hono<AppEnv>;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

// ── Tool catalog ──────────────────────────────────────────────────────────────

export const MCP_TOOLS = [
  {
    name: "list_properties",
    description:
      "List all managed properties (name, address, timezone). Use this to pick a property_id before drilling into units or bookings.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_units",
    description:
      "List bookable units. Each unit has a kind of 'atomic' (a single room) or 'composite' (a collection of atomic units, e.g. a whole-house listing that contains individual rooms). Use this to understand the inventory graph before checking availability or creating bookings.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_listings",
    description:
      "List channel listings. Each listing maps a unit to a platform (Airbnb, VRBO, Booking.com, direct) and carries the inbound iCal URL and outbound iCal export token. Useful for auditing listing consistency across platforms.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_platforms",
    description:
      "List the booking platforms this agent knows about (slug, display name, adapter).",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_bookings",
    description:
      "List bookings, optionally filtered by unit and date range. Returns holds, confirmed reservations, and cancelled ones — check the status field. Dates are YYYY-MM-DD; end_date is checkout (exclusive).",
    inputSchema: {
      type: "object" as const,
      properties: {
        unit_id: { type: "number" as const, description: "Optional unit id to filter by." },
        from: { type: "string" as const, description: "Optional start-of-window date (YYYY-MM-DD). Returns bookings whose end_date > from." },
        to: { type: "string" as const, description: "Optional end-of-window date (YYYY-MM-DD). Returns bookings whose start_date < to." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check_availability",
    description:
      "Check whether a unit is available over a date range. Respects the inventory graph: booking a room on an atomic unit marks the parent composite (whole house) unavailable, and vice-versa.",
    inputSchema: {
      type: "object" as const,
      properties: {
        unit_id: { type: "number" as const, description: "Unit id to check." },
        start: { type: "string" as const, description: "Check-in date (YYYY-MM-DD)." },
        end: { type: "string" as const, description: "Checkout date (YYYY-MM-DD, exclusive)." },
      },
      required: ["unit_id", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "pull_all_calendars",
    description:
      "Force a pull of every active listing's inbound iCal feed now. Blocks the outgoing calendars automatically with anything it finds. Normally this runs on a 10-minute cron; call it for ad-hoc refreshes.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "sync_log",
    description:
      "Read the most recent sync-log entries — one row per iCal pull, including source, listing, events imported, and any error. Useful for diagnosing a stuck channel.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
];

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function handleMcp(
  message: JsonRpcMessage,
  env: Env,
  app: GuestBookingHono,
): Promise<unknown> {
  const { id, method, params } = message;

  if (!method) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "guest-booking", version: "0.1.0" },
        instructions:
          "Guest-booking agent: channel manager for Airbnb/VRBO/Booking.com. Use list_* to read inventory, check_availability to verify a date range respecting the nested-inventory graph, and pull_all_calendars to force-refresh inbound feeds.",
      },
    };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await dispatchTool(name, args, env, app);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }] },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { jsonrpc: "2.0", id, error: { code: -32000, message: errorMessage } };
    }
  }

  if (method === "notifications/initialized") return null;

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  app: GuestBookingHono,
): Promise<string> {
  const call = async (method: string, path: string, body?: unknown): Promise<string> => {
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        // The admin middleware checks x-admin-token; forward the
        // worker's configured token so MCP calls are treated as admin.
        "x-admin-token": env.ADMIN_TOKEN ?? "",
      },
    };
    if (body !== undefined && method !== "GET") {
      init.body = JSON.stringify(body);
    }
    const res = await app.request(path, init, env);
    return res.text();
  };

  switch (name) {
    case "list_properties":
      return call("GET", "/api/properties");

    case "list_units":
      return call("GET", "/api/units");

    case "list_listings":
      return call("GET", "/api/listings");

    case "list_platforms":
      return call("GET", "/api/platforms");

    case "list_bookings":
      return call("GET", withQuery("/api/bookings", args));

    case "check_availability": {
      const unitId = args.unit_id;
      const start = args.start;
      const end = args.end;
      if (unitId == null || !start || !end) {
        throw new Error("check_availability requires unit_id, start, and end");
      }
      return call(
        "GET",
        withQuery("/api/availability", { unit_id: unitId, start, end }),
      );
    }

    case "pull_all_calendars":
      return call("POST", "/api/sync/pull-all");

    case "sync_log":
      return call("GET", "/api/sync-log");

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withQuery(base: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (entries.length === 0) return base;
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${base}?${qs}`;
}
