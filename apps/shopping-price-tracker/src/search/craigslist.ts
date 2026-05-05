/**
 * Craigslist RSS adapter — used local listings.
 *
 * Hits the per-city RSS feed (e.g.
 * https://sfbay.craigslist.org/search/sss?query=...&format=rss) and
 * pulls the price out of each <title>. Free, deterministic, and avoids
 * Craigslist's HTML which churns. Skips entirely if CRAIGSLIST_CITY is
 * unset so the agent boots cleanly before configuration. Items whose
 * title has no parseable "$NNN" price are dropped.
 */

import type { Env, TrackedItem } from "../types";
import { nowIso } from "../lib/time";
import type { Listing } from "./types";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const MAX_RESULTS = 8;

export async function searchCraigslist(item: TrackedItem, env: Env): Promise<Listing[]> {
  if (item.kind !== "product") return [];
  const city = env.CRAIGSLIST_CITY;
  if (!city) return [];
  const q = buildQuery(item);
  if (!q) return [];

  const url = new URL(`https://${encodeURIComponent(city)}.craigslist.org/search/sss`);
  url.searchParams.set("query", q);
  url.searchParams.set("format", "rss");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ShoppingPriceTracker/1.0)",
        Accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn("[craigslist] HTTP", res.status);
      return [];
    }
    const buf = await res.arrayBuffer();
    const bytes = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    const xml = new TextDecoder().decode(bytes);
    return parseRss(xml).slice(0, MAX_RESULTS);
  } catch (e) {
    console.warn("[craigslist] error:", e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function buildQuery(item: TrackedItem): string {
  const parts: string[] = [];
  if (item.title) parts.push(item.title);
  if (item.model_number) parts.push(item.model_number);
  if (item.query_strings.length > 0) parts.push(item.query_strings[0]!);
  return parts.join(" ").trim();
}

function parseRss(xml: string): Listing[] {
  const out: Listing[] = [];
  const itemRe = /<item\b([^>]*)>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null = itemRe.exec(xml);
  while (m !== null) {
    const attrs = m[1] ?? "";
    const block = m[2] ?? "";
    const title = decodeXml(extractTag(block, "title"));
    // RDF/RSS 1.0 sometimes only carries the URL on rdf:about=…; fall back.
    const link =
      decodeXml(extractTag(block, "link")) ||
      attrs.match(/rdf:about=["']([^"']+)["']/)?.[1] ||
      "";

    if (title && link) {
      const cents = extractPriceCents(title);
      if (cents !== null) {
        out.push({
          source: "craigslist",
          title,
          url: link,
          priceCents: cents,
          currency: "USD",
          observedAt: nowIso(),
        });
      }
    }
    m = itemRe.exec(xml);
  }
  return out;
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(
    `<${tag}\\b[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`,
    "i",
  );
  const match = block.match(re);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function extractPriceCents(title: string): number | null {
  const m = title.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (!m?.[1]) return null;
  const n = Number.parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 16)));
}
