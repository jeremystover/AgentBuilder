/**
 * One-shot URL discovery on intake.
 *
 * Called by add_tracked_item right after insert. Asks Claude (with
 * web_search) to find current product pages across major US retailers
 * and return the URLs. The result is persisted onto the item's
 * `watch_urls` so subsequent daily checks can scrape those pages
 * cheaply via the URL-watch adapter without spending a web_search
 * credit per refresh.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env, TrackedItem } from "../types";
import { extractFirstJsonArray } from "./_json";

const MODEL = "claude-sonnet-4-6";
// biome-ignore lint/suspicious/noExplicitAny: see claude_web.ts
const WEB_SEARCH_TOOL: any = { type: "web_search_20250305", name: "web_search", max_uses: 3 };

const MAX_URLS = 8;

interface DiscoveredListing {
  retailer: string;
  url: string;
  title: string;
  price_usd?: number;
  in_stock?: boolean;
}

export async function discoverProductUrls(
  item: TrackedItem,
  env: Env,
): Promise<{ urls: string[]; listings: DiscoveredListing[] }> {
  if (item.kind !== "product") return { urls: [], listings: [] };
  if (!env.ANTHROPIC_API_KEY) return { urls: [], listings: [] };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const prompt = buildPrompt(item);

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      // biome-ignore lint/suspicious/noExplicitAny: see WEB_SEARCH_TOOL above
      tools: [WEB_SEARCH_TOOL] as any,
      messages: [{ role: "user", content: prompt }],
    });
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
    }
    const arr = extractFirstJsonArray(text) ?? [];
    const listings: DiscoveredListing[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const url = typeof r["url"] === "string" ? (r["url"] as string) : null;
      if (!url) continue;
      listings.push({
        retailer: typeof r["retailer"] === "string" ? (r["retailer"] as string) : "",
        url,
        title:
          typeof r["title"] === "string"
            ? (r["title"] as string)
            : typeof r["page_title"] === "string"
              ? (r["page_title"] as string)
              : "",
        price_usd:
          typeof r["price_usd"] === "number"
            ? (r["price_usd"] as number)
            : typeof r["current_price_usd"] === "number"
              ? (r["current_price_usd"] as number)
              : undefined,
        in_stock: typeof r["in_stock"] === "boolean" ? (r["in_stock"] as boolean) : undefined,
      });
    }
    const urls = dedupe(listings.map((l) => l.url)).slice(0, MAX_URLS);
    return { urls, listings: listings.slice(0, MAX_URLS) };
  } catch (e) {
    console.warn("[claude_discover] error:", e);
    return { urls: [], listings: [] };
  }
}

function buildPrompt(item: TrackedItem): string {
  const lines: string[] = [];
  lines.push(
    `Find current product listings for "${item.title}"${item.model_number ? ` (model ${item.model_number})` : ""} on major US retailers.`,
  );
  // ACP-integrated retailers (as of 2026 OpenAI Agentic Commerce Protocol
  // discovery roster) tend to expose the freshest structured product data
  // for agent consumption, so prefer those when they actually stock the
  // item. Then fall through to the rest of the major-retailer field.
  lines.push(
    "Prefer ACP-integrated retailers when they stock the item: Target, Best Buy, The Home Depot, Lowe's, Wayfair, Nordstrom, Sephora. Then check Amazon, Walmart, B&H, Newegg, Apple, and any other major US retailer with stock.",
  );
  if (item.description) lines.push(`Description: ${item.description}`);
  if (item.notes) lines.push(`Notes: ${item.notes}`);
  if (item.retailers.length > 0)
    lines.push(`Buyer-specified retailer preference: ${item.retailers.join(", ")}.`);
  lines.push(
    "Use web_search. Pick the canonical product page URL on each retailer (the one a shopper would land on, not a search-results page).",
  );
  lines.push(
    `Return ONLY a JSON array (no prose, no markdown fence) of up to ${MAX_URLS} objects with these exact keys:`,
  );
  lines.push(
    `[{"retailer": string, "url": string, "title": string, "price_usd": number | null, "in_stock": boolean | null}]`,
  );
  lines.push("If no listings are found, return [].");
  return lines.join("\n");
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const key = canonicalize(u);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    // Strip common tracking params; keep meaningful ones.
    const stripPrefixes = ["utm_", "tag", "ref", "linkCode", "psc"];
    for (const key of [...u.searchParams.keys()]) {
      if (stripPrefixes.some((p) => key.toLowerCase().startsWith(p))) {
        u.searchParams.delete(key);
      }
    }
    return `${u.hostname.toLowerCase()}${u.pathname}`;
  } catch {
    return url.toLowerCase();
  }
}
