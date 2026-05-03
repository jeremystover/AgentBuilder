/**
 * eBay Browse API adapter.
 *
 * Free supplement to Claude web_search. Catches used/auction listings the
 * web search rarely surfaces. Skips entirely if EBAY_APP_ID is not set so
 * the agent boots cleanly before signup.
 *
 * Note: the Browse API endpoint accepts the App ID directly as a Bearer
 * token for read-only product search (no per-request OAuth dance needed).
 */

import type { Env, TrackedItem } from "../types";
import { nowIso } from "../lib/time";
import type { Listing } from "./types";

const ENDPOINT = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 8;

export async function searchEbay(item: TrackedItem, env: Env): Promise<Listing[]> {
  if (item.kind !== "product") return [];
  const appId = env.EBAY_APP_ID;
  if (!appId) return [];

  const q = buildQuery(item);
  if (!q) return [];

  const url = new URL(ENDPOINT);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(MAX_RESULTS));
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE|AUCTION},priceCurrency:USD");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${appId}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("[ebay] HTTP", res.status, await res.text().catch(() => ""));
      return [];
    }
    const body = (await res.json()) as { itemSummaries?: EbayItem[] };
    const items = body.itemSummaries ?? [];
    return items
      .map((i) => toListing(i))
      .filter((x): x is Listing => x !== null)
      .slice(0, MAX_RESULTS);
  } catch (e) {
    console.warn("[ebay] error:", e);
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

interface EbayItem {
  itemId?: string;
  title?: string;
  itemWebUrl?: string;
  price?: { value?: string; currency?: string };
  shippingOptions?: Array<{ shippingCost?: { value?: string; currency?: string } }>;
  itemAffiliateWebUrl?: string;
  buyingOptions?: string[];
}

function toListing(i: EbayItem): Listing | null {
  const priceStr = i.price?.value;
  const url = i.itemWebUrl ?? i.itemAffiliateWebUrl;
  if (!priceStr || !url || !i.title) return null;
  const cents = Math.round(Number.parseFloat(priceStr) * 100);
  if (!Number.isFinite(cents)) return null;
  const shippingStr = i.shippingOptions?.[0]?.shippingCost?.value;
  const shippingCents = shippingStr ? Math.round(Number.parseFloat(shippingStr) * 100) : undefined;
  return {
    source: "ebay",
    title: i.title,
    url,
    priceCents: cents,
    currency: i.price?.currency ?? "USD",
    shippingCents: Number.isFinite(shippingCents) ? shippingCents : undefined,
    observedAt: nowIso(),
  };
}
