import { z } from "zod";
import { flightQueries, itemQueries } from "../../lib/db";
import { dollarsToCents } from "../../lib/money";
import type { Env } from "../../types";

export const UpdateTrackedItemInput = z.object({
  item_id: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  model_number: z.string().max(100).optional(),
  query_strings: z.array(z.string()).max(10).optional(),
  retailers: z.array(z.string()).max(20).optional(),
  watch_urls: z.array(z.string().url()).max(20).optional(),
  target_price_usd: z.number().nonnegative().nullable().optional(),
  max_price_usd: z.number().nonnegative().nullable().optional(),
  notes: z.string().max(2000).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
  flight: z
    .object({
      origin: z.string().min(2).max(8).optional(),
      destination: z.string().min(2).max(8).optional(),
      depart_start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      depart_end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      return_start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      return_end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      nonstop: z.boolean().optional(),
      cabin: z.enum(["economy", "premium_economy", "business", "first"]).optional(),
      pax: z.number().int().min(1).max(9).optional(),
      max_stops: z.number().int().min(0).max(3).nullable().optional(),
    })
    .optional(),
});

export type UpdateTrackedItemInput = z.infer<typeof UpdateTrackedItemInput>;

export async function updateTrackedItem(input: UpdateTrackedItemInput, env: Env) {
  const existing = await itemQueries.findById(env.DB, input.item_id);
  if (!existing) return { error: "Item not found" };

  const patch: Parameters<typeof itemQueries.update>[2] = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.model_number !== undefined) patch.model_number = input.model_number;
  if (input.query_strings !== undefined) patch.query_strings = input.query_strings;
  if (input.retailers !== undefined) patch.retailers = input.retailers;
  if (input.watch_urls !== undefined) patch.watch_urls = input.watch_urls;
  if (input.target_price_usd !== undefined)
    patch.target_price_cents = input.target_price_usd === null ? null : dollarsToCents(input.target_price_usd);
  if (input.max_price_usd !== undefined)
    patch.max_price_cents = input.max_price_usd === null ? null : dollarsToCents(input.max_price_usd);
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.status !== undefined) patch.status = input.status;

  const updated = await itemQueries.update(env.DB, input.item_id, patch);

  if (input.flight && existing.kind === "flight") {
    const current = await flightQueries.findByItem(env.DB, input.item_id);
    if (current) {
      await flightQueries.upsert(env.DB, {
        item_id: input.item_id,
        origin: input.flight.origin?.toUpperCase() ?? current.origin,
        destination: input.flight.destination?.toUpperCase() ?? current.destination,
        depart_start: input.flight.depart_start ?? current.depart_start,
        depart_end: input.flight.depart_end ?? current.depart_end,
        return_start:
          input.flight.return_start === undefined ? current.return_start : input.flight.return_start,
        return_end:
          input.flight.return_end === undefined ? current.return_end : input.flight.return_end,
        nonstop: input.flight.nonstop ?? current.nonstop,
        cabin: input.flight.cabin ?? current.cabin,
        pax: input.flight.pax ?? current.pax,
        max_stops: input.flight.max_stops === undefined ? current.max_stops : input.flight.max_stops,
      });
    }
  }

  return { item: updated };
}
