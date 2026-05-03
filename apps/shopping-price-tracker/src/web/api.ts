/**
 * REST API for both the SPA (cookie-auth at /app/api/*) and external
 * apps (bearer at /api/v1/*). Both surfaces dispatch through the same
 * routeApi() function — auth is enforced upstream in src/index.ts.
 */

import { ZodError } from "zod";
import {
  digestRunQueries,
  flightQueries,
  itemQueries,
  observationQueries,
  recipientQueries,
} from "../lib/db";
import { isoDaysAgo } from "../lib/time";
import { runSearchForItem, runSearchForItems } from "../search";
import {
  AddTrackedItemInput,
  addTrackedItem,
} from "../mcp/tools/add_tracked_item";
import { UpdateTrackedItemInput, updateTrackedItem } from "../mcp/tools/update_tracked_item";
import type { Env } from "../types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}

function errorResponse(message: string, status: number, details?: unknown): Response {
  return jsonResponse({ error: message, ...(details ? { details } : {}) }, status);
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Match a path against a prefix and return the suffix segments. Returns
 * null if the path doesn't match.
 */
function matchPath(pathname: string, prefix: string): string[] | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).replace(/^\/+/, "").replace(/\/+$/, "");
  if (rest === "") return [];
  return rest.split("/");
}

export async function routeApi(
  request: Request,
  env: Env,
  apiPrefix: string,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = matchPath(url.pathname, apiPrefix);
  if (segments === null) return errorResponse("Not found", 404);

  try {
    return await dispatch(request, env, segments, url);
  } catch (e) {
    if (e instanceof ZodError) {
      return errorResponse("Invalid input", 400, e.flatten().fieldErrors);
    }
    console.error("[api] error:", e);
    return errorResponse(e instanceof Error ? e.message : "Internal error", 500);
  }
}

async function dispatch(
  request: Request,
  env: Env,
  segments: string[],
  url: URL,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const [head, id, sub] = segments;

  // /items
  if (head === "items") {
    if (id === undefined) {
      if (method === "GET") {
        const status = (url.searchParams.get("status") as "active" | "paused" | "archived" | null) ?? undefined;
        const kind = (url.searchParams.get("kind") as "product" | "flight" | null) ?? undefined;
        const items = await itemQueries.list(env.DB, { status, kind });
        const enriched = await Promise.all(
          items.map(async (item) => {
            const flight = item.kind === "flight" ? await flightQueries.findByItem(env.DB, item.id) : null;
            const obs = await observationQueries.listForItem(env.DB, item.id, { limit: 1 });
            return { ...item, flight, latest_observation: obs[0] ?? null };
          }),
        );
        return jsonResponse({ items: enriched, count: enriched.length });
      }
      if (method === "POST") {
        const body = await readJson<Record<string, unknown>>(request);
        if (!body) return errorResponse("Body must be JSON", 400);
        const input = AddTrackedItemInput.parse(body);
        const result = await addTrackedItem(input, env);
        return jsonResponse(result, 201);
      }
      return errorResponse("Method not allowed", 405);
    }

    // /items/:id
    if (sub === undefined) {
      if (method === "GET") {
        const item = await itemQueries.findById(env.DB, id);
        if (!item) return errorResponse("Not found", 404);
        const days = Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30;
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200;
        const flight = item.kind === "flight" ? await flightQueries.findByItem(env.DB, id) : null;
        const observations = await observationQueries.listForItem(env.DB, id, {
          since: isoDaysAgo(days),
          limit,
        });
        return jsonResponse({ item, flight, observations });
      }
      if (method === "PATCH") {
        const body = await readJson<Record<string, unknown>>(request);
        if (!body) return errorResponse("Body must be JSON", 400);
        const input = UpdateTrackedItemInput.parse({ ...body, item_id: id });
        const result = await updateTrackedItem(input, env);
        return jsonResponse(result);
      }
      if (method === "DELETE") {
        const hard = url.searchParams.get("hard") === "true";
        if (hard) {
          await observationQueries.deleteForItem(env.DB, id);
          await itemQueries.delete(env.DB, id);
          return jsonResponse({ item_id: id, deleted: "hard" });
        }
        await itemQueries.update(env.DB, id, { status: "archived" });
        return jsonResponse({ item_id: id, deleted: "archived" });
      }
      return errorResponse("Method not allowed", 405);
    }

    // /items/:id/refresh
    if (sub === "refresh" && method === "POST") {
      const item = await itemQueries.findById(env.DB, id);
      if (!item) return errorResponse("Not found", 404);
      const result = await runSearchForItem(env, item);
      return jsonResponse({
        item_id: item.id,
        observation_count: result.listings.length,
        errors: result.errors,
      });
    }

    return errorResponse("Not found", 404);
  }

  // /refresh-all  (SPA convenience)
  if (head === "refresh-all" && method === "POST") {
    const items = await itemQueries.list(env.DB, { status: "active" });
    const results = await runSearchForItems(env, items);
    return jsonResponse({
      processed: results.length,
      observation_count: results.reduce((n, r) => n + r.listings.length, 0),
    });
  }

  // /digests
  if (head === "digests") {
    if (id === undefined) {
      if (method === "GET") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "30", 10) || 30;
        const runs = await digestRunQueries.list(env.DB, limit);
        // Strip html from list view to keep payload small.
        return jsonResponse({
          runs: runs.map(({ summary_html, ...rest }) => rest),
        });
      }
      return errorResponse("Method not allowed", 405);
    }
    if (sub === undefined && method === "GET") {
      const run = await digestRunQueries.findById(env.DB, id);
      if (!run) return errorResponse("Not found", 404);
      return jsonResponse({ run });
    }
    return errorResponse("Not found", 404);
  }

  // /recipients
  if (head === "recipients") {
    if (method === "GET") {
      const recipients = await recipientQueries.list(env.DB);
      return jsonResponse({ recipients });
    }
    if (method === "POST") {
      const body = await readJson<{ email?: string }>(request);
      const email = body?.email?.trim();
      if (!email) return errorResponse("email required", 400);
      await recipientQueries.add(env.DB, email);
      return jsonResponse({ added: email.toLowerCase() }, 201);
    }
    if (method === "DELETE") {
      const email = url.searchParams.get("email");
      if (!email) return errorResponse("email required", 400);
      await recipientQueries.remove(env.DB, email);
      return jsonResponse({ removed: email.toLowerCase() });
    }
    return errorResponse("Method not allowed", 405);
  }

  return errorResponse("Not found", 404);
}
