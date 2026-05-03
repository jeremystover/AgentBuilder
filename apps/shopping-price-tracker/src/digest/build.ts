/**
 * Daily digest pipeline.
 *
 * 1. Pull all active items.
 * 2. Run search adapters (insert observations).
 * 3. Compute today's best price per item + 14-day rolling median.
 * 4. Tag items: hit-target | above-max | drop | sale | no-change.
 * 5. Hand off to render.ts which produces text + html bodies.
 */

import { LLMClient } from "@agentbuilder/llm";
import { flightQueries, itemQueries, observationQueries } from "../lib/db";
import { median } from "../lib/money";
import { isoDaysAgo, isoDate, nowIso } from "../lib/time";
import { runSearchForItems } from "../search";
import type { Env, FlightConstraints, PriceObservation, TrackedItem } from "../types";

export type DigestTag = "hit-target" | "above-max" | "drop" | "sale" | "no-change";

export interface DigestEntry {
  item: TrackedItem;
  flight: FlightConstraints | null;
  bestToday: PriceObservation | null;
  rolling14Median: number | null;
  tags: DigestTag[];
  sparkline: number[];        // last 14 days, daily best (for HTML chart)
  oneLiner: string;           // LLM-generated, optional
}

export interface BuiltDigest {
  ranAt: string;
  entries: DigestEntry[];
  itemCount: number;
  winnersParagraph: string;   // LLM-generated overview
}

const ONE_DAY_MS = 86_400_000;

export async function buildDigest(env: Env): Promise<BuiltDigest> {
  const ranAt = nowIso();
  const items = await itemQueries.list(env.DB, { status: "active" });

  // Run search across all items first, so observations are fresh.
  await runSearchForItems(env, items);

  const entries: DigestEntry[] = [];
  for (const item of items) {
    const flight = item.kind === "flight" ? await flightQueries.findByItem(env.DB, item.id) : null;

    const since = isoDaysAgo(14);
    const recent = await observationQueries.listForItem(env.DB, item.id, { since, limit: 500 });

    const todayKey = isoDate(ranAt);
    const today = recent.filter((o) => isoDate(o.observed_at) === todayKey);
    const bestToday = today.reduce<PriceObservation | null>(
      (best, o) => (best === null || o.price_cents < best.price_cents ? o : best),
      null,
    );

    const rolling14Median = median(recent.map((o) => o.price_cents));
    const sparkline = computeSparkline(recent, 14);

    entries.push({
      item,
      flight,
      bestToday,
      rolling14Median,
      tags: tagEntry(item, bestToday, rolling14Median, today),
      sparkline,
      oneLiner: "",
    });
  }

  // LLM summaries: 'fast' tier per item, 'default' tier for the daily winners
  // paragraph. Failure to summarize is non-fatal — fall back to ''.
  let llm: LLMClient | null = null;
  if (env.ANTHROPIC_API_KEY) {
    llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY });
  }

  if (llm) {
    await Promise.all(
      entries.map(async (e) => {
        try {
          e.oneLiner = await summarizeItem(llm!, e);
        } catch (err) {
          console.warn("[digest/build] item summary failed:", err);
        }
      }),
    );
  }

  let winnersParagraph = "";
  if (llm && entries.length > 0) {
    try {
      winnersParagraph = await summarizeWinners(llm, entries);
    } catch (err) {
      console.warn("[digest/build] winners summary failed:", err);
    }
  }

  return { ranAt, entries, itemCount: items.length, winnersParagraph };
}

function tagEntry(
  item: TrackedItem,
  bestToday: PriceObservation | null,
  rolling14Median: number | null,
  today: PriceObservation[],
): DigestTag[] {
  const tags: DigestTag[] = [];
  if (!bestToday) {
    tags.push("no-change");
    return tags;
  }
  if (item.target_price_cents !== null && bestToday.price_cents <= item.target_price_cents) {
    tags.push("hit-target");
  }
  if (item.max_price_cents !== null && bestToday.price_cents > item.max_price_cents) {
    tags.push("above-max");
  }
  if (rolling14Median && bestToday.price_cents <= Math.round(rolling14Median * 0.9)) {
    tags.push("drop");
  }
  if (today.some((o) => o.sale_flag)) {
    tags.push("sale");
  }
  if (tags.length === 0) tags.push("no-change");
  return tags;
}

function computeSparkline(observations: PriceObservation[], days: number): number[] {
  if (observations.length === 0) return [];
  const now = Date.now();
  const buckets = new Array<number[]>(days).fill(null as unknown as number[]).map(() => [] as number[]);
  for (const o of observations) {
    const t = Date.parse(o.observed_at);
    if (!Number.isFinite(t)) continue;
    const ageDays = Math.floor((now - t) / ONE_DAY_MS);
    if (ageDays < 0 || ageDays >= days) continue;
    const idx = days - 1 - ageDays;
    buckets[idx]!.push(o.price_cents);
  }
  return buckets.map((b) => (b.length === 0 ? 0 : Math.min(...b)));
}

async function summarizeItem(llm: LLMClient, entry: DigestEntry): Promise<string> {
  const facts = entryFactsLine(entry);
  const res = await llm.complete({
    tier: "fast",
    system:
      "You write one-line price-tracker updates. Be terse. No emojis. Plain prose only. Reference prices in dollars. Mention the buyer's target if relevant.",
    messages: [
      {
        role: "user",
        content: `Write a single sentence (max 25 words) summarizing today's status for this tracked item. Facts: ${facts}`,
      },
    ],
    maxOutputTokens: 80,
  });
  return res.text.trim().split(/\r?\n/)[0] ?? "";
}

async function summarizeWinners(llm: LLMClient, entries: DigestEntry[]): Promise<string> {
  const lines = entries.map((e) => entryFactsLine(e));
  const res = await llm.complete({
    tier: "default",
    system:
      "You write a short opening paragraph for a daily price-tracker email. Highlight the 1-3 best opportunities right now (target hits, sales, big drops). Plain prose, no emojis, no markdown headers, max 80 words.",
    messages: [
      {
        role: "user",
        content: `Tracked items today:\n${lines.join("\n")}\n\nWrite the opener.`,
      },
    ],
    maxOutputTokens: 220,
  });
  return res.text.trim();
}

function entryFactsLine(e: DigestEntry): string {
  const parts: string[] = [];
  parts.push(`"${e.item.title}"`);
  if (e.item.kind === "flight" && e.flight) {
    parts.push(`(${e.flight.origin}→${e.flight.destination})`);
  } else if (e.item.model_number) {
    parts.push(`(${e.item.model_number})`);
  }
  if (e.bestToday) {
    parts.push(`best today $${(e.bestToday.price_cents / 100).toFixed(2)} via ${e.bestToday.source}`);
  } else {
    parts.push("no listings found today");
  }
  if (e.item.target_price_cents !== null) {
    parts.push(`target $${(e.item.target_price_cents / 100).toFixed(2)}`);
  }
  if (e.rolling14Median) {
    parts.push(`14d median $${(e.rolling14Median / 100).toFixed(2)}`);
  }
  if (e.tags.length > 0) parts.push(`[${e.tags.join(", ")}]`);
  return parts.join(" ");
}
