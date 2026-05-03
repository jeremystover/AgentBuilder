/**
 * Search orchestrator.
 *
 * For each item, run the enabled adapters in parallel and persist the
 * union of returned listings as price_observations. A single failing
 * adapter never blocks the run — Promise.allSettled isolates failures.
 */

import { newId } from "../lib/ids";
import { observationQueries, flightQueries } from "../lib/db";
import { nowIso } from "../lib/time";
import type { Env, PriceObservation, TrackedItem } from "../types";
import { searchClaudeWeb } from "./claude_web";
import { searchClaudeFlights } from "./claude_flights";
import { searchEbay } from "./ebay";
import { searchUrlWatch } from "./url_watch";
import type { Listing } from "./types";

export interface ItemSearchResult {
  itemId: string;
  listings: Listing[];
  errors: string[];
}

export async function runSearchForItem(env: Env, item: TrackedItem): Promise<ItemSearchResult> {
  const errors: string[] = [];

  const adapters: Promise<Listing[]>[] = [];
  if (item.kind === "product") {
    adapters.push(safe(searchClaudeWeb(item, env), errors, "claude_web"));
    adapters.push(safe(searchUrlWatch(item, env), errors, "url_watch"));
    adapters.push(safe(searchEbay(item, env), errors, "ebay"));
  } else if (item.kind === "flight") {
    const fc = await flightQueries.findByItem(env.DB, item.id);
    if (fc) {
      adapters.push(safe(searchClaudeFlights(item, fc, env), errors, "claude_flights"));
    } else {
      errors.push("flight item missing constraints row");
    }
  }

  const results = await Promise.all(adapters);
  const flat: Listing[] = results.flat();

  if (flat.length > 0) {
    const obs: PriceObservation[] = flat.map((l) => ({
      id: newId(),
      item_id: item.id,
      source: l.source,
      listing_title: l.title.slice(0, 500),
      listing_url: l.url.slice(0, 1000),
      price_cents: l.priceCents,
      shipping_cents: l.shippingCents ?? null,
      currency: l.currency,
      in_stock: l.inStock ?? null,
      sale_flag: l.saleFlag ?? false,
      raw_json: l.raw ? JSON.stringify(l.raw).slice(0, 4000) : null,
      observed_at: l.observedAt || nowIso(),
    }));
    await observationQueries.insertMany(env.DB, obs);
  }

  return { itemId: item.id, listings: flat, errors };
}

export async function runSearchForItems(
  env: Env,
  items: TrackedItem[],
): Promise<ItemSearchResult[]> {
  const out: ItemSearchResult[] = [];
  for (const item of items) {
    out.push(await runSearchForItem(env, item));
  }
  return out;
}

async function safe<T>(p: Promise<T[]>, errs: string[], label: string): Promise<T[]> {
  try {
    return await p;
  } catch (e) {
    errs.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
