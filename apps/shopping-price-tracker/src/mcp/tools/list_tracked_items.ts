import { z } from "zod";
import { flightQueries, itemQueries, observationQueries } from "../../lib/db";
import type { Env } from "../../types";

export const ListTrackedItemsInput = z.object({
  status: z.enum(["active", "paused", "archived"]).optional(),
  kind: z.enum(["product", "flight"]).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  include_latest: z.boolean().optional().default(true),
});

export type ListTrackedItemsInput = z.infer<typeof ListTrackedItemsInput>;

export async function listTrackedItems(input: ListTrackedItemsInput, env: Env) {
  const items = await itemQueries.list(env.DB, {
    status: input.status,
    kind: input.kind,
    priority: input.priority,
  });

  const enriched = await Promise.all(
    items.map(async (item) => {
      const flight = item.kind === "flight" ? await flightQueries.findByItem(env.DB, item.id) : null;
      let latest = null;
      if (input.include_latest) {
        const obs = await observationQueries.listForItem(env.DB, item.id, { limit: 1 });
        latest = obs[0] ?? null;
      }
      return { ...item, flight, latest_observation: latest };
    }),
  );

  return { items: enriched, count: enriched.length };
}
