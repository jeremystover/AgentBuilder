import { z } from "zod";
import { flightQueries, itemQueries } from "../../lib/db";
import { newId } from "../../lib/ids";
import { dollarsToCents } from "../../lib/money";
import { nowIso } from "../../lib/time";
import { discoverProductUrls } from "../../search/claude_discover";
import type { Env, TrackedItem } from "../../types";

export const AddTrackedItemInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("product"),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional().default(""),
    model_number: z.string().max(100).optional().default(""),
    query_strings: z.array(z.string()).max(10).optional().default([]),
    retailers: z.array(z.string()).max(20).optional().default([]),
    watch_urls: z.array(z.string().url()).max(20).optional().default([]),
    target_price_usd: z.number().nonnegative().optional(),
    max_price_usd: z.number().nonnegative().optional(),
    notes: z.string().max(2000).optional().default(""),
    priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
    discover_urls: z.boolean().optional().default(true),
  }),
  z.object({
    kind: z.literal("flight"),
    title: z.string().min(1).max(200).optional(),
    origin: z.string().min(2).max(8),
    destination: z.string().min(2).max(8),
    depart_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    depart_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
    nonstop: z.boolean().optional().default(false),
    cabin: z
      .enum(["economy", "premium_economy", "business", "first"])
      .optional()
      .default("economy"),
    pax: z.number().int().min(1).max(9).optional().default(1),
    max_stops: z.number().int().min(0).max(3).nullable().optional(),
    target_price_usd: z.number().nonnegative().optional(),
    max_price_usd: z.number().nonnegative().optional(),
    notes: z.string().max(2000).optional().default(""),
    priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
  }),
]);

export type AddTrackedItemInput = z.infer<typeof AddTrackedItemInput>;

export async function addTrackedItem(input: AddTrackedItemInput, env: Env) {
  const id = newId();
  const now = nowIso();

  if (input.kind === "product") {
    const item: TrackedItem = {
      id,
      kind: "product",
      title: input.title,
      description: input.description,
      model_number: input.model_number,
      query_strings: input.query_strings,
      retailers: input.retailers,
      watch_urls: input.watch_urls,
      target_price_cents: dollarsToCents(input.target_price_usd ?? null),
      max_price_cents: dollarsToCents(input.max_price_usd ?? null),
      currency: "USD",
      notes: input.notes,
      priority: input.priority,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    await itemQueries.create(env.DB, item);

    let discovered: string[] = [];
    if (input.discover_urls && input.watch_urls.length === 0) {
      const result = await discoverProductUrls(item, env);
      discovered = result.urls;
      if (discovered.length > 0) {
        const merged = uniq([...item.watch_urls, ...discovered]);
        await itemQueries.update(env.DB, id, { watch_urls: merged });
        item.watch_urls = merged;
      }
    }

    return { item, discovered_urls: discovered };
  }

  // Flight
  const item: TrackedItem = {
    id,
    kind: "flight",
    title: input.title || `${input.origin} → ${input.destination}`,
    description: "",
    model_number: "",
    query_strings: [],
    retailers: [],
    watch_urls: [],
    target_price_cents: dollarsToCents(input.target_price_usd ?? null),
    max_price_cents: dollarsToCents(input.max_price_usd ?? null),
    currency: "USD",
    notes: input.notes,
    priority: input.priority,
    status: "active",
    created_at: now,
    updated_at: now,
  };
  await itemQueries.create(env.DB, item);
  await flightQueries.upsert(env.DB, {
    item_id: id,
    origin: input.origin.toUpperCase(),
    destination: input.destination.toUpperCase(),
    depart_start: input.depart_start,
    depart_end: input.depart_end,
    return_start: input.return_start ?? null,
    return_end: input.return_end ?? null,
    nonstop: input.nonstop,
    cabin: input.cabin,
    pax: input.pax,
    max_stops: input.max_stops ?? null,
  });

  return { item, discovered_urls: [] };
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}
