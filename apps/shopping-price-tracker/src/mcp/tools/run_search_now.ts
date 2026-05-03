import { z } from "zod";
import { itemQueries } from "../../lib/db";
import { runSearchForItem, runSearchForItems } from "../../search";
import type { Env } from "../../types";

export const RunSearchNowInput = z.object({
  item_id: z.string().uuid().optional(),
  /** When true (and item_id is omitted), search every active item. */
  all_active: z.boolean().optional().default(false),
});

export type RunSearchNowInput = z.infer<typeof RunSearchNowInput>;

export async function runSearchNow(input: RunSearchNowInput, env: Env) {
  if (input.item_id) {
    const item = await itemQueries.findById(env.DB, input.item_id);
    if (!item) return { error: "Item not found" };
    const result = await runSearchForItem(env, item);
    return {
      item_id: result.itemId,
      observation_count: result.listings.length,
      sources: countBy(result.listings.map((l) => l.source)),
      errors: result.errors,
    };
  }

  if (input.all_active) {
    const items = await itemQueries.list(env.DB, { status: "active" });
    const results = await runSearchForItems(env, items);
    return {
      processed: results.length,
      observation_count: results.reduce((n, r) => n + r.listings.length, 0),
      errors: results.flatMap((r) => r.errors.map((e) => `${r.itemId}: ${e}`)),
    };
  }

  return { error: "Provide either item_id or all_active=true" };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
