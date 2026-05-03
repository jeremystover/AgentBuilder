import { z } from "zod";
import { itemQueries, observationQueries } from "../../lib/db";
import type { Env } from "../../types";

export const RemoveTrackedItemInput = z.object({
  item_id: z.string().uuid(),
  /** When true, also delete all price observations. */
  hard: z.boolean().optional().default(false),
});

export type RemoveTrackedItemInput = z.infer<typeof RemoveTrackedItemInput>;

export async function removeTrackedItem(input: RemoveTrackedItemInput, env: Env) {
  const existing = await itemQueries.findById(env.DB, input.item_id);
  if (!existing) return { error: "Item not found" };

  if (input.hard) {
    await observationQueries.deleteForItem(env.DB, input.item_id);
    await itemQueries.delete(env.DB, input.item_id);
    return { item_id: input.item_id, deleted: "hard" };
  }

  await itemQueries.update(env.DB, input.item_id, { status: "archived" });
  return { item_id: input.item_id, deleted: "archived" };
}
