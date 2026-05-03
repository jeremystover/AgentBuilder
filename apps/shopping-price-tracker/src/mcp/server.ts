/**
 * MCP JSON-RPC 2.0 server for shopping-price-tracker.
 *
 * Methods: initialize | tools/list | tools/call
 * Auth: Bearer MCP_HTTP_KEY (enforced by the worker; this module trusts
 * the request has already been authenticated).
 */

import { ZodError } from "zod";
import type { Env } from "../types";
import { AddTrackedItemInput, addTrackedItem } from "./tools/add_tracked_item";
import { GetItemHistoryInput, getItemHistory } from "./tools/get_item_history";
import { LatestDigestInput, latestDigest } from "./tools/latest_digest";
import { ListTrackedItemsInput, listTrackedItems } from "./tools/list_tracked_items";
import {
  ManageDigestRecipientsInput,
  manageDigestRecipients,
} from "./tools/manage_digest_recipients";
import { RemoveTrackedItemInput, removeTrackedItem } from "./tools/remove_tracked_item";
import { RunSearchNowInput, runSearchNow } from "./tools/run_search_now";
import { UpdateTrackedItemInput, updateTrackedItem } from "./tools/update_tracked_item";

const TOOL_MANIFESTS = [
  {
    name: "add_tracked_item",
    description:
      "Track a product or flight for daily price refresh. For products, only a description / model number is needed — the agent uses Claude web_search to auto-discover retailer URLs and saves them as watch_urls. For flights, supply origin / destination / date windows.",
    inputSchema: {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["product", "flight"] },
        title: { type: "string", maxLength: 200 },
        description: { type: "string", maxLength: 2000 },
        model_number: { type: "string", maxLength: 100 },
        query_strings: { type: "array", items: { type: "string" }, maxItems: 10 },
        retailers: { type: "array", items: { type: "string" }, maxItems: 20 },
        watch_urls: { type: "array", items: { type: "string", format: "uri" }, maxItems: 20 },
        target_price_usd: { type: "number", minimum: 0 },
        max_price_usd: { type: "number", minimum: 0 },
        notes: { type: "string", maxLength: 2000 },
        priority: { type: "string", enum: ["low", "normal", "high"], default: "normal" },
        discover_urls: { type: "boolean", default: true, description: "(product only) auto-discover URLs via Claude web_search" },
        origin: { type: "string", description: "(flight) IATA code, e.g. JFK" },
        destination: { type: "string", description: "(flight) IATA code, e.g. LIS" },
        depart_start: { type: "string", description: "(flight) earliest depart date YYYY-MM-DD" },
        depart_end: { type: "string", description: "(flight) latest depart date YYYY-MM-DD" },
        return_start: { type: "string", description: "(flight) earliest return date YYYY-MM-DD" },
        return_end: { type: "string", description: "(flight) latest return date YYYY-MM-DD" },
        nonstop: { type: "boolean", default: false },
        cabin: {
          type: "string",
          enum: ["economy", "premium_economy", "business", "first"],
          default: "economy",
        },
        pax: { type: "integer", minimum: 1, maximum: 9, default: 1 },
        max_stops: { type: "integer", minimum: 0, maximum: 3 },
      },
    },
  },
  {
    name: "update_tracked_item",
    description:
      "Update fields on an existing tracked item. Supports patching title, model number, query strings, watch URLs, target/max price, priority, status, and (for flights) the date windows / cabin / pax.",
    inputSchema: {
      type: "object",
      required: ["item_id"],
      additionalProperties: false,
      properties: {
        item_id: { type: "string", format: "uuid" },
        title: { type: "string", maxLength: 200 },
        description: { type: "string", maxLength: 2000 },
        model_number: { type: "string", maxLength: 100 },
        query_strings: { type: "array", items: { type: "string" }, maxItems: 10 },
        retailers: { type: "array", items: { type: "string" }, maxItems: 20 },
        watch_urls: { type: "array", items: { type: "string", format: "uri" }, maxItems: 20 },
        target_price_usd: { type: ["number", "null"], minimum: 0 },
        max_price_usd: { type: ["number", "null"], minimum: 0 },
        notes: { type: "string", maxLength: 2000 },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        status: { type: "string", enum: ["active", "paused", "archived"] },
        flight: {
          type: "object",
          additionalProperties: false,
          properties: {
            origin: { type: "string" },
            destination: { type: "string" },
            depart_start: { type: "string" },
            depart_end: { type: "string" },
            return_start: { type: ["string", "null"] },
            return_end: { type: ["string", "null"] },
            nonstop: { type: "boolean" },
            cabin: { type: "string", enum: ["economy", "premium_economy", "business", "first"] },
            pax: { type: "integer", minimum: 1, maximum: 9 },
            max_stops: { type: ["integer", "null"], minimum: 0, maximum: 3 },
          },
        },
      },
    },
  },
  {
    name: "list_tracked_items",
    description: "List tracked items with optional filters and the latest observation per item.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "string", enum: ["active", "paused", "archived"] },
        kind: { type: "string", enum: ["product", "flight"] },
        priority: { type: "string", enum: ["low", "normal", "high"] },
        include_latest: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "remove_tracked_item",
    description: "Archive an item (soft delete). Pass hard=true to also delete its observations.",
    inputSchema: {
      type: "object",
      required: ["item_id"],
      additionalProperties: false,
      properties: {
        item_id: { type: "string", format: "uuid" },
        hard: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "get_item_history",
    description:
      "Return an item plus its price observations over a recent window (default 30 days). Useful for charts or 'tell me what this thing has been doing'.",
    inputSchema: {
      type: "object",
      required: ["item_id"],
      additionalProperties: false,
      properties: {
        item_id: { type: "string", format: "uuid" },
        days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 200 },
      },
    },
  },
  {
    name: "run_search_now",
    description:
      "Force a price refresh immediately for one item or every active item. Useful for testing without waiting for the cron.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        item_id: { type: "string", format: "uuid" },
        all_active: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "latest_digest",
    description: "Return the most recent daily digest run (markdown summary by default; HTML on request).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { include_html: { type: "boolean", default: false } },
    },
  },
  {
    name: "manage_digest_recipients",
    description: "List, add, or remove email addresses that receive the daily digest.",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"] },
        email: { type: "string", format: "email" },
      },
    },
  },
] as const;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
  TOOL_NOT_FOUND: { code: -32000, message: "Tool not found" },
  TOOL_ERROR: { code: -32001, message: "Tool execution error" },
} as const;

function ok(id: JsonRpcMessage["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(
  id: JsonRpcMessage["id"] | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

async function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<unknown> {
  switch (toolName) {
    case "add_tracked_item":
      return addTrackedItem(AddTrackedItemInput.parse(args), env);
    case "update_tracked_item":
      return updateTrackedItem(UpdateTrackedItemInput.parse(args), env);
    case "list_tracked_items":
      return listTrackedItems(ListTrackedItemsInput.parse(args), env);
    case "remove_tracked_item":
      return removeTrackedItem(RemoveTrackedItemInput.parse(args), env);
    case "get_item_history":
      return getItemHistory(GetItemHistoryInput.parse(args), env);
    case "run_search_now":
      return runSearchNow(RunSearchNowInput.parse(args), env);
    case "latest_digest":
      return latestDigest(LatestDigestInput.parse(args), env);
    case "manage_digest_recipients":
      return manageDigestRecipients(ManageDigestRecipientsInput.parse(args), env);
    default:
      return null;
  }
}

function jsonResponse(body: JsonRpcResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(err(null, RPC_ERRORS.PARSE_ERROR.code, RPC_ERRORS.PARSE_ERROR.message));
  }

  if (
    !body ||
    typeof body !== "object" ||
    (body as Record<string, unknown>)["jsonrpc"] !== "2.0" ||
    typeof (body as Record<string, unknown>)["method"] !== "string"
  ) {
    const id = (body as Record<string, unknown> | null)?.["id"] as JsonRpcMessage["id"] | undefined;
    return jsonResponse(err(id ?? null, RPC_ERRORS.INVALID_REQUEST.code, RPC_ERRORS.INVALID_REQUEST.message));
  }

  const req = body as JsonRpcMessage;
  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      return jsonResponse(
        ok(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "shopping-price-tracker", version: "0.0.1" },
          instructions:
            "Track product and flight prices daily; email a separate digest. Use add_tracked_item to start tracking; the agent auto-discovers retailer URLs.",
        }),
      );
    }

    if (method === "tools/list") {
      return jsonResponse(ok(id, { tools: TOOL_MANIFESTS }));
    }

    if (method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }

    if (method === "tools/call") {
      if (!params || typeof params !== "object") {
        return jsonResponse(err(id, RPC_ERRORS.INVALID_PARAMS.code, "params required for tools/call"));
      }
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      const toolName = p.name;
      const toolArgs = p.arguments ?? {};
      if (!toolName) {
        return jsonResponse(err(id, RPC_ERRORS.INVALID_PARAMS.code, "tools/call requires params.name"));
      }
      if (!TOOL_MANIFESTS.some((t) => t.name === toolName)) {
        return jsonResponse(err(id, RPC_ERRORS.TOOL_NOT_FOUND.code, `Unknown tool: ${toolName}`));
      }

      let result: unknown;
      try {
        result = await dispatchTool(toolName, toolArgs as Record<string, unknown>, env);
      } catch (e) {
        if (e instanceof ZodError) {
          return jsonResponse(
            err(id, RPC_ERRORS.INVALID_PARAMS.code, "Invalid tool arguments", e.flatten().fieldErrors),
          );
        }
        return jsonResponse(
          err(id, RPC_ERRORS.TOOL_ERROR.code, e instanceof Error ? e.message : String(e)),
        );
      }

      return jsonResponse(
        ok(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        }),
      );
    }

    return jsonResponse(err(id, RPC_ERRORS.METHOD_NOT_FOUND.code, `Method not found: ${method}`));
  } catch (e) {
    console.error("[mcp] unhandled error:", e);
    return jsonResponse(err(id, RPC_ERRORS.INTERNAL_ERROR.code, e instanceof Error ? e.message : String(e)));
  }
}
