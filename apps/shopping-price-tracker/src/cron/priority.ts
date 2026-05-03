/**
 * Priority cron — runs every 4 hours on `priority='high'` items only.
 * No email; just a price refresh so high-priority items have fresher data
 * for the next daily digest. Per-item rate guard suppresses duplicate
 * runs within 90 minutes (e.g. when crons overlap manual run_search_now).
 */

import { itemQueries, observationQueries } from "../lib/db";
import { runSearchForItem } from "../search";
import type { Env } from "../types";

const RATE_GUARD_MS = 90 * 60 * 1000;

export async function runPriorityRefresh(env: Env): Promise<void> {
  const items = await itemQueries.list(env.DB, { status: "active", priority: "high" });
  if (items.length === 0) {
    console.log("[cron/priority] no high-priority items");
    return;
  }

  const now = Date.now();
  let processed = 0;
  for (const item of items) {
    const recent = await observationQueries.listForItem(env.DB, item.id, { limit: 1 });
    const lastObs = recent[0];
    if (lastObs) {
      const age = now - Date.parse(lastObs.observed_at);
      if (age < RATE_GUARD_MS) continue;
    }
    await runSearchForItem(env, item);
    processed++;
  }
  console.log(`[cron/priority] processed ${processed}/${items.length}`);
}
