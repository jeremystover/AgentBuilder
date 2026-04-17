import { z } from "zod";
import type { Env } from "../../types";
import { watchQueries, watchHitQueries } from "../../lib/db";
import type { WatchRow } from "../../lib/db";

const ALLOWED_INTERVALS = [5, 15, 30, 60, 240, 1440] as const;

export const ManageWatchesInput = z.discriminatedUnion("action", [
  z.object({
    action:           z.literal("create"),
    name:             z.string().min(1).max(120).describe("Human-friendly name (e.g., 'Taylor Swift tour presale')"),
    url:              z.string().url().describe("Page to watch"),
    interval_minutes: z.number().int().refine((n) => (ALLOWED_INTERVALS as readonly number[]).includes(n), {
      message: `interval_minutes must be one of ${ALLOWED_INTERVALS.join(", ")}`,
    }).describe("Check interval: 5, 15, 30, 60 (1h), 240 (4h), or 1440 (1d)"),
    match_type:       z.enum(["contains", "not_contains", "regex", "hash"]).describe(
      "contains: fire when text appears | not_contains: fire when text disappears | regex: fire on regex match | hash: fire on any page change",
    ),
    match_value:      z.string().max(500).optional().describe("Substring or regex (required for contains/not_contains/regex; ignored for hash)"),
    notify_email:     z.string().email().describe("Where to send the notification"),
    notify_mode:      z.enum(["once", "every"]).default("once").describe(
      "once: only first match (resets when page stops matching) | every: every check that matches",
    ),
  }),
  z.object({ action: z.literal("list"), enabled_only: z.boolean().default(false) }),
  z.object({ action: z.literal("get"), watch_id: z.string().uuid(), include_hits: z.boolean().default(false) }),
  z.object({
    action:           z.literal("update"),
    watch_id:         z.string().uuid(),
    name:             z.string().min(1).max(120).optional(),
    interval_minutes: z.number().int().refine((n) => (ALLOWED_INTERVALS as readonly number[]).includes(n)).optional(),
    match_type:       z.enum(["contains", "not_contains", "regex", "hash"]).optional(),
    match_value:      z.string().max(500).nullable().optional(),
    notify_email:     z.string().email().optional(),
    notify_mode:      z.enum(["once", "every"]).optional(),
  }),
  z.object({ action: z.literal("pause"),  watch_id: z.string().uuid() }),
  z.object({ action: z.literal("resume"), watch_id: z.string().uuid() }),
  z.object({ action: z.literal("delete"), watch_id: z.string().uuid() }),
]);

export type ManageWatchesInput = z.infer<typeof ManageWatchesInput>;

function requireMatchValue(type: string, value: string | undefined | null): string | null {
  if (type === "hash") return null;
  if (!value || !value.trim()) {
    throw new Error(`match_value is required for match_type="${type}"`);
  }
  return value;
}

function presentWatch(w: WatchRow) {
  return {
    id:                 w.id,
    name:               w.name,
    url:                w.url,
    interval_minutes:   w.interval_minutes,
    match_type:         w.match_type,
    match_value:        w.match_value,
    notify_email:       w.notify_email,
    notify_mode:        w.notify_mode,
    enabled:            w.enabled === 1,
    last_checked_at:    w.last_checked_at,
    last_matched_at:    w.last_matched_at,
    last_notified_at:   w.last_notified_at,
    last_error:         w.last_error,
    consecutive_errors: w.consecutive_errors,
    created_at:         w.created_at,
  };
}

export async function manageWatches(input: ManageWatchesInput, env: Env) {
  switch (input.action) {
    case "create": {
      const matchValue = requireMatchValue(input.match_type, input.match_value);
      const id = crypto.randomUUID();
      await watchQueries.create(env.CONTENT_DB, {
        id,
        name:             input.name,
        url:              input.url,
        interval_minutes: input.interval_minutes,
        match_type:       input.match_type,
        match_value:      matchValue,
        notify_email:     input.notify_email,
        notify_mode:      input.notify_mode,
      });
      const row = await watchQueries.findById(env.CONTENT_DB, id);
      return { watch: row ? presentWatch(row) : null };
    }

    case "list": {
      const rows = await watchQueries.list(env.CONTENT_DB, input.enabled_only ? { enabled: true } : {});
      return { watches: rows.map(presentWatch), count: rows.length };
    }

    case "get": {
      const row = await watchQueries.findById(env.CONTENT_DB, input.watch_id);
      if (!row) return { error: "Watch not found" };
      const result: Record<string, unknown> = { watch: presentWatch(row) };
      if (input.include_hits) {
        result["hits"] = await watchHitQueries.listForWatch(env.CONTENT_DB, input.watch_id, 20);
      }
      return result;
    }

    case "update": {
      const existing = await watchQueries.findById(env.CONTENT_DB, input.watch_id);
      if (!existing) return { error: "Watch not found" };
      const patch = {
        name:             input.name,
        interval_minutes: input.interval_minutes,
        match_type:       input.match_type,
        match_value:      input.match_value,
        notify_email:     input.notify_email,
        notify_mode:      input.notify_mode,
      };
      if (patch.match_type && patch.match_type !== "hash") {
        const effective = patch.match_value !== undefined ? patch.match_value : existing.match_value;
        if (!effective || !effective.trim()) {
          throw new Error(`match_value is required for match_type="${patch.match_type}"`);
        }
      }
      const updated = await watchQueries.update(env.CONTENT_DB, input.watch_id, patch);
      return { watch: updated ? presentWatch(updated) : null };
    }

    case "pause": {
      await watchQueries.setEnabled(env.CONTENT_DB, input.watch_id, false);
      return { watch_id: input.watch_id, enabled: false };
    }

    case "resume": {
      await watchQueries.setEnabled(env.CONTENT_DB, input.watch_id, true);
      return { watch_id: input.watch_id, enabled: true };
    }

    case "delete": {
      await watchQueries.delete(env.CONTENT_DB, input.watch_id);
      return { watch_id: input.watch_id, deleted: true };
    }
  }
}
