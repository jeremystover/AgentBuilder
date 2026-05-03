/**
 * Claude API web_search adapter — daily product price refresh.
 *
 * One Claude completion per item with the server-side `web_search` tool
 * enabled. Prompted to return a JSON list of current best prices across
 * major US retailers; we parse the JSON out of the response and convert
 * to Listing[].
 *
 * Cost: roughly 1 search per item per call (~$0.01 each via web_search
 * billing) plus modest token usage.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env, TrackedItem } from "../types";
import { nowIso } from "../lib/time";
import type { Listing } from "./types";
import { extractFirstJsonArray } from "./_json";

const MODEL = "claude-sonnet-4-6";
const WEB_SEARCH_TOOL_NAME = "web_search";
// biome-ignore lint/suspicious/noExplicitAny: Anthropic SDK types lag behind
// the published web_search tool spec; cast to keep the call site honest
// without forking type defs.
const WEB_SEARCH_TOOL: any = { type: "web_search_20250305", name: WEB_SEARCH_TOOL_NAME, max_uses: 3 };

const MAX_RESULTS = 8;

export async function searchClaudeWeb(item: TrackedItem, env: Env): Promise<Listing[]> {
  if (item.kind !== "product") return [];
  if (!env.ANTHROPIC_API_KEY) return [];

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const skipHosts = collectSkipHosts(item.watch_urls);
  const prompt = buildPrompt(item, skipHosts);

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      // biome-ignore lint/suspicious/noExplicitAny: see WEB_SEARCH_TOOL above
      tools: [WEB_SEARCH_TOOL] as any,
      messages: [{ role: "user", content: prompt }],
    });
    const text = collectText(res.content);
    return parseListings(text, skipHosts);
  } catch (e) {
    console.warn("[claude_web] error:", e);
    return [];
  }
}

function buildPrompt(item: TrackedItem, skipHosts: string[]): string {
  const lines: string[] = [];
  const modelTag = item.model_number ? ` (model ${item.model_number})` : "";
  lines.push(
    `What is the current best price for "${item.title}"${modelTag} across major US retailers right now?`,
  );
  if (item.notes) lines.push(`Buyer notes: ${item.notes}`);
  if (item.target_price_cents)
    lines.push(`Buyer's target price: $${(item.target_price_cents / 100).toFixed(2)}`);
  lines.push(
    "Use web_search to check Amazon, Walmart, Target, Best Buy, B&H, Newegg, Apple, and any major US retailer with stock. Note any active sales.",
  );

  if (skipHosts.length > 0) {
    lines.push(
      `Skip these domains entirely — we already track them directly: ${skipHosts.join(", ")}.`,
    );
  }

  lines.push("");
  lines.push("Strict extraction rules — follow exactly:");
  if (item.model_number) {
    lines.push(
      `- Return a price ONLY if the listing page identifies the product as model "${item.model_number}". Match against the page title, breadcrumbs, or spec table — not nearby items.`,
    );
  } else {
    lines.push(
      `- Return a price ONLY if the listing page is for "${item.title}" itself, not a similar or related product.`,
    );
  }
  lines.push(
    "- Do NOT extract prices from carousels, \"customers also bought\", \"recommended\", \"related\", \"sponsored\", or promotional banners — only the main product price for the page you are on.",
  );
  lines.push(
    "- The `url` you return must be the canonical product page for the matched item.",
  );
  lines.push(
    "- The `title` you return must be the listing's own product title (so a reviewer can verify the match), not a synthesized name.",
  );
  lines.push("- If you cannot confirm the model match for a retailer, omit it.");
  lines.push("");
  lines.push(
    `Return ONLY a JSON array (no prose, no markdown fence) of up to ${MAX_RESULTS} objects with these exact keys:`,
  );
  lines.push(
    `[{"retailer": string, "url": string, "title": string, "price_usd": number, "in_stock": boolean, "sale_flag": boolean, "shipping_usd": number | null}]`,
  );
  lines.push("If no prices are found, return [].");
  return lines.join("\n");
}

function collectSkipHosts(watchUrls: string[]): string[] {
  const hosts = new Set<string>();
  for (const u of watchUrls) {
    try {
      const h = new URL(u).hostname.replace(/^www\./, "");
      if (h) hosts.add(h);
    } catch {
      // ignore malformed entries
    }
  }
  return [...hosts].sort();
}

interface ParsedListing {
  retailer?: string;
  url?: string;
  title?: string;
  price_usd?: number;
  in_stock?: boolean;
  sale_flag?: boolean;
  shipping_usd?: number | null;
}

function parseListings(text: string, skipHosts: string[]): Listing[] {
  const arr = extractFirstJsonArray(text);
  if (!arr) return [];
  const skip = new Set(skipHosts);
  const out: Listing[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as ParsedListing;
    if (!r.url || typeof r.url !== "string") continue;
    if (typeof r.price_usd !== "number" || !Number.isFinite(r.price_usd)) continue;
    if (skip.size > 0 && skip.has(hostnameOf(r.url).replace(/^www\./, ""))) continue;
    out.push({
      source: "claude_web",
      title: r.title || r.retailer || hostnameOf(r.url),
      url: r.url,
      priceCents: Math.round(r.price_usd * 100),
      currency: "USD",
      inStock: typeof r.in_stock === "boolean" ? r.in_stock : undefined,
      saleFlag: typeof r.sale_flag === "boolean" ? r.sale_flag : undefined,
      shippingCents:
        typeof r.shipping_usd === "number" && Number.isFinite(r.shipping_usd)
          ? Math.round(r.shipping_usd * 100)
          : undefined,
      observedAt: nowIso(),
    });
  }
  return out.slice(0, MAX_RESULTS);
}

function collectText(content: Anthropic.Messages.ContentBlock[]): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
