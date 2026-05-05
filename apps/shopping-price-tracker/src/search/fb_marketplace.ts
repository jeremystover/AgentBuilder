/**
 * Facebook Marketplace adapter, via the secondhandmcp.com MCP server.
 *
 * FB Marketplace is location-based, so we fan out one MCP call per city
 * (item-level `fb_locations` overrides the env-level `FB_DEFAULT_LOCATIONS`
 * default). The MCP server speaks JSON-RPC 2.0 over HTTP with optional SSE
 * framing — we accept either response content type.
 *
 * Skips entirely if no location is resolved so the agent boots cleanly
 * before `FB_DEFAULT_LOCATIONS` is configured.
 */

import type { Env, TrackedItem } from "../types";
import { nowIso } from "../lib/time";
import type { Listing } from "./types";

const DEFAULT_MCP_URL = "https://secondhandmcp.com/mcp";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESULTS_PER_LOCATION = 6;

export async function searchFbMarketplace(item: TrackedItem, env: Env): Promise<Listing[]> {
  if (item.kind !== "product") return [];
  const locations = resolveLocations(item, env);
  if (locations.length === 0) return [];

  const query = buildQuery(item);
  if (!query) return [];

  const url = env.FB_MCP_URL || DEFAULT_MCP_URL;
  const settled = await Promise.allSettled(
    locations.map((loc) => callOne(url, env, query, loc)),
  );
  const out: Listing[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.warn("[fb_marketplace] error:", r.reason);
  }
  return out;
}

function resolveLocations(item: TrackedItem, env: Env): string[] {
  if (item.fb_locations && item.fb_locations.length > 0) return item.fb_locations;
  return (env.FB_DEFAULT_LOCATIONS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildQuery(item: TrackedItem): string {
  const parts: string[] = [];
  if (item.title) parts.push(item.title);
  if (item.model_number) parts.push(item.model_number);
  if (item.query_strings.length > 0) parts.push(item.query_strings[0]!);
  return parts.join(" ").trim();
}

async function callOne(
  url: string,
  env: Env,
  query: string,
  location: string,
): Promise<Listing[]> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_marketplace",
      arguments: {
        marketplace: "facebook",
        query,
        location,
        limit: MAX_RESULTS_PER_LOCATION,
      },
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (env.FB_MCP_TOKEN) headers.Authorization = `Bearer ${env.FB_MCP_TOKEN}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        "[fb_marketplace] HTTP",
        res.status,
        location,
        await res.text().catch(() => ""),
      );
      return [];
    }
    const payload = await readMcpResponse(res);
    return parseListings(payload, location);
  } finally {
    clearTimeout(timer);
  }
}

interface McpResponse {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message?: string };
}

async function readMcpResponse(res: Response): Promise<McpResponse | null> {
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("text/event-stream")) {
    const text = await res.text();
    let last: string | null = null;
    for (const block of text.split(/\n\n/)) {
      const data = block
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (data) last = data;
    }
    if (!last) return null;
    try {
      return JSON.parse(last) as McpResponse;
    } catch {
      return null;
    }
  }
  return (await res.json()) as McpResponse;
}

interface FbItem {
  title?: string;
  url?: string;
  link?: string;
  price?: number | string;
  currency?: string;
  condition?: string;
  postedAt?: string;
  location?: string;
}

function parseListings(payload: McpResponse | null, location: string): Listing[] {
  if (!payload?.result || payload.result.isError) {
    if (payload?.error?.message) {
      console.warn("[fb_marketplace] mcp error:", location, payload.error.message);
    }
    return [];
  }
  const text = payload.result.content?.find((c) => c.type === "text")?.text;
  if (!text) return [];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return [];
  }
  const items = extractItems(body);
  const out: Listing[] = [];
  for (const i of items) {
    const cents = toCents(i.price);
    const url = i.url ?? i.link;
    if (cents === null || !url || !i.title) continue;
    out.push({
      source: "fb_marketplace",
      title: i.title,
      url,
      priceCents: cents,
      currency: i.currency || "USD",
      observedAt: nowIso(),
      raw: { location, condition: i.condition, postedAt: i.postedAt },
    });
  }
  return out;
}

function extractItems(body: unknown): FbItem[] {
  if (Array.isArray(body)) return body as FbItem[];
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  for (const key of ["results", "items", "listings", "data"]) {
    const v = obj[key];
    if (Array.isArray(v)) return v as FbItem[];
  }
  return [];
}

function toCents(price: unknown): number | null {
  if (price === null || price === undefined) return null;
  if (typeof price === "number") {
    if (!Number.isFinite(price)) return null;
    return Math.round(price * 100);
  }
  const s = String(price).replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
