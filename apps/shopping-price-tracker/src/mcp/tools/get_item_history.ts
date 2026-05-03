import { z } from "zod";
import { flightQueries, itemQueries, observationQueries } from "../../lib/db";
import { isoDaysAgo } from "../../lib/time";
import type { Env } from "../../types";

export const GetItemHistoryInput = z.object({
  item_id: z.string().uuid(),
  days: z.number().int().min(1).max(365).optional().default(30),
  limit: z.number().int().min(1).max(500).optional().default(200),
});

export type GetItemHistoryInput = z.infer<typeof GetItemHistoryInput>;

export async function getItemHistory(input: GetItemHistoryInput, env: Env) {
  const item = await itemQueries.findById(env.DB, input.item_id);
  if (!item) return { error: "Item not found" };

  const since = isoDaysAgo(input.days);
  const observations = await observationQueries.listForItem(env.DB, input.item_id, {
    since,
    limit: input.limit,
  });
  const flight = item.kind === "flight" ? await flightQueries.findByItem(env.DB, input.item_id) : null;

  return {
    item,
    flight,
    observations,
    since,
    count: observations.length,
  };
}
