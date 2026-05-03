/**
 * URL-watch adapter.
 *
 * For each saved watch_url on a product item, fetch the page and extract
 * the price from JSON-LD (`Product.offers.price`) first, then Open Graph
 * (`product:price:amount`), then a plain regex on `$X.XX` near the title.
 *
 * Free, deterministic, fast — runs every digest pass without spending a
 * Claude web_search call. Fail-soft per URL: a single broken page does
 * not stop the rest.
 */

import type { Env, TrackedItem } from "../types";
import { nowIso } from "../lib/time";
import type { Listing } from "./types";

const FETCH_HEADERS: HeadersInit = {
  "User-Agent": "Mozilla/5.0 (compatible; ShoppingPriceTracker/1.0)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 3_000_000;

export async function searchUrlWatch(item: TrackedItem, _env: Env): Promise<Listing[]> {
  if (item.kind !== "product") return [];
  const urls = item.watch_urls.filter((u) => /^https?:\/\//.test(u));
  if (urls.length === 0) return [];
  const results = await Promise.allSettled(urls.map((u) => scrapeOne(u)));
  const out: Listing[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
  }
  return out;
}

async function scrapeOne(url: string): Promise<Listing | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const bytes = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    const html = new TextDecoder().decode(bytes);
    const parsed = extractFromHtml(html);
    if (!parsed) return null;
    return {
      source: "url_watch",
      title: parsed.title || hostnameOf(url),
      url,
      priceCents: parsed.priceCents,
      currency: parsed.currency || "USD",
      inStock: parsed.inStock,
      saleFlag: parsed.saleFlag,
      observedAt: nowIso(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Extracted {
  title: string | null;
  priceCents: number;
  currency: string | null;
  inStock?: boolean;
  saleFlag?: boolean;
}

function extractFromHtml(html: string): Extracted | null {
  // 1. JSON-LD blocks. Prefer schema.org Product.offers.price.
  const ldBlocks = findJsonLdBlocks(html);
  for (const obj of ldBlocks) {
    const found = extractFromLdNode(obj);
    if (found) return found;
  }

  // 2. Open Graph product price meta tags.
  const ogAmount = matchMeta(html, /property=["']product:price:amount["']/i);
  const ogCurrency = matchMeta(html, /property=["']product:price:currency["']/i);
  if (ogAmount) {
    const cents = priceToCents(ogAmount);
    if (cents !== null) {
      const ogTitle = matchMeta(html, /property=["']og:title["']/i);
      return {
        title: ogTitle,
        priceCents: cents,
        currency: ogCurrency,
      };
    }
  }

  // 3. Microdata fallback: itemprop="price"
  const itemprop = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
  if (itemprop?.[1]) {
    const cents = priceToCents(itemprop[1]);
    if (cents !== null) {
      const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      return {
        title: titleTag?.[1]?.trim() ?? null,
        priceCents: cents,
        currency: null,
      };
    }
  }

  return null;
}

function findJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    const raw = m[1]?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) blocks.push(...parsed);
        else blocks.push(parsed);
      } catch {
        // ignore malformed JSON-LD
      }
    }
    m = re.exec(html);
  }
  return blocks;
}

function extractFromLdNode(node: unknown): Extracted | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const isProduct =
    type === "Product" || (Array.isArray(type) && type.includes("Product"));

  if (isProduct) {
    const offers = obj["offers"];
    const o = pickOffer(offers);
    if (o) {
      const cents = priceToCents(o.price);
      if (cents !== null) {
        return {
          title: typeof obj["name"] === "string" ? (obj["name"] as string) : null,
          priceCents: cents,
          currency: typeof o.currency === "string" ? o.currency : null,
          inStock: o.availability ? /InStock/i.test(o.availability) : undefined,
        };
      }
    }
  }

  // Recurse into @graph arrays (common in WordPress / Shopify exports).
  const graph = obj["@graph"];
  if (Array.isArray(graph)) {
    for (const sub of graph) {
      const found = extractFromLdNode(sub);
      if (found) return found;
    }
  }
  return null;
}

interface OfferInfo {
  price: unknown;
  currency: unknown;
  availability?: string;
}

function pickOffer(offers: unknown): OfferInfo | null {
  if (!offers) return null;
  if (Array.isArray(offers)) {
    let best: OfferInfo | null = null;
    for (const o of offers) {
      const info = pickOffer(o);
      if (info && info.price !== undefined) {
        const cents = priceToCents(info.price);
        if (cents !== null) {
          if (!best || cents < (priceToCents(best.price) ?? Infinity)) best = info;
        }
      }
    }
    return best;
  }
  if (typeof offers !== "object") return null;
  const o = offers as Record<string, unknown>;
  if (o["lowPrice"] !== undefined || o["price"] !== undefined) {
    return {
      price: o["lowPrice"] ?? o["price"],
      currency: o["priceCurrency"],
      availability: typeof o["availability"] === "string" ? (o["availability"] as string) : undefined,
    };
  }
  return null;
}

function matchMeta(html: string, selector: RegExp): string | null {
  // Looks for <meta {selector} content="X"> or <meta content="X" {selector}>.
  const re = new RegExp(
    `<meta[^>]+(?:${selector.source})[^>]+content=["']([^"']+)["']`,
    selector.flags,
  );
  const reReverse = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:${selector.source})`,
    selector.flags,
  );
  return html.match(re)?.[1] ?? html.match(reReverse)?.[1] ?? null;
}

function priceToCents(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
