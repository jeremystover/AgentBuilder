/**
 * Variant selection + tone-aware copy templates (Phase C v1).
 *
 * Goals (from the spec):
 *   - "A/B test message tone/framing ... day-to-day"
 *   - "Praise should feel genuine and reflect actual progress made"
 *
 * Design choices we're locking in for v1:
 *
 *   1. Variants live in CODE, not a DB table. Three hardcoded "tones"
 *      (casual / formal / concise). Adding a fourth or retiring an
 *      underperformer is a code change, not a DB UPDATE. We can promote
 *      to a table once the surface-area justifies admin tooling.
 *
 *   2. DAILY rotation per person. variant = pick(active, hash(person+date))
 *      — same person experiences the same tone all day, which is what
 *      "day-to-day" framing implies. No per-message coin flip.
 *
 *   3. NO auto-optimization yet. The stats endpoint surfaces response
 *      and resolution rates per variant; the operator decides whether
 *      to retire one (set is_active=false here, redeploy). Phase C v2
 *      can layer a bandit on top once we have ≥100 sends per variant.
 *
 *   4. We persist variant_id on every sms_session so historical stats
 *      survive code changes (variant IDs are versioned: casual_v1,
 *      casual_v2, etc.).
 *
 * Tone semantics (illustrative — see render() below for actuals):
 *   - casual:  "Quick one for ya — Lyft $24 4/12, sound like travel?"
 *   - formal:  "Could you categorize this? Lyft · $24 · 4/12 — looks like travel?"
 *   - concise: "Lyft $24 4/12 → travel? 1=yes 2=jeremy"
 */

import type { Suggestion, BatchItem } from './sms-dispatcher-shared';

export type Tone = 'casual' | 'formal' | 'concise';

export interface Variant {
  id: string;        // versioned, e.g. "casual_v1"
  tone: Tone;
  is_active: boolean;
  weight: number;    // higher = more sessions; 0 = retired
}

export const VARIANTS: Variant[] = [
  { id: 'casual_v1',  tone: 'casual',  is_active: true, weight: 1 },
  { id: 'formal_v1',  tone: 'formal',  is_active: true, weight: 1 },
  { id: 'concise_v1', tone: 'concise', is_active: true, weight: 1 },
];

// ── Selection ──────────────────────────────────────────────────────────────

/**
 * Pick a variant for (person, dateKey). Deterministic — the same input
 * always returns the same variant — so "1" reply later in the day reads
 * the same tone as the morning's prompt.
 *
 * dateKey is the local date in the person's timezone (YYYY-MM-DD), which
 * is what sms-dispatcher already computes via localNow().
 */
export function pickVariant(person: 'jeremy' | 'elyse', dateKey: string): Variant {
  const active = VARIANTS.filter((v) => v.is_active && v.weight > 0);
  if (active.length === 0) {
    // Last-ditch — keep the system functional even if all variants
    // are retired. Falls back to casual_v1.
    return VARIANTS[0]!;
  }

  // Build a weighted bucket; hash the (person+date) string into [0, total).
  const total = active.reduce((sum, v) => sum + v.weight, 0);
  const h = hash32(`${person}:${dateKey}`) % 1_000_000;
  const target = (h / 1_000_000) * total;
  let acc = 0;
  for (const v of active) {
    acc += v.weight;
    if (target < acc) return v;
  }
  return active[active.length - 1]!;
}

function hash32(s: string): number {
  // FNV-1a 32-bit. Worker-friendly (no Buffer), deterministic, no deps.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ── Tone-aware rendering ───────────────────────────────────────────────────

interface InitialContext {
  merchant: string;
  amount_str: string;
  date: string;        // MM-DD
  guess: string | null;
}

export function renderInitialByTone(tone: Tone, ctx: InitialContext): string {
  const tail = `Reply 1 yes, 2 to send to Jeremy, or describe it. PAUSE to stop.`;
  const tailNoGuess = `Tell me what category, or 2 to send to Jeremy. PAUSE to stop.`;

  switch (tone) {
    case 'casual': {
      if (ctx.guess) {
        return [
          `Quick one — ${ctx.merchant} · ${ctx.amount_str} · ${ctx.date}.`,
          `Looks like ${ctx.guess}?`,
          tail,
        ].join('\n');
      }
      return [
        `Quick one — ${ctx.merchant} · ${ctx.amount_str} · ${ctx.date}.`,
        `Not sure on this one — what category?`,
        tailNoGuess,
      ].join('\n');
    }
    case 'formal': {
      if (ctx.guess) {
        return [
          `Could you help categorize this transaction?`,
          `${ctx.merchant} · ${ctx.amount_str} · ${ctx.date}`,
          `My best guess: ${ctx.guess}. Is that correct?`,
          tail,
        ].join('\n');
      }
      return [
        `Could you help categorize this transaction?`,
        `${ctx.merchant} · ${ctx.amount_str} · ${ctx.date}`,
        `What category should this be?`,
        tailNoGuess,
      ].join('\n');
    }
    case 'concise': {
      if (ctx.guess) {
        return [
          `${ctx.merchant} ${ctx.amount_str} ${ctx.date} → ${ctx.guess}?`,
          `1=yes 2=jeremy PAUSE`,
        ].join('\n');
      }
      return [
        `${ctx.merchant} ${ctx.amount_str} ${ctx.date} → ?`,
        `Reply category, 2=jeremy, PAUSE`,
      ].join('\n');
    }
  }
}

export function renderBatchByTone(tone: Tone, items: BatchItem[], lineFor: (item: BatchItem) => { merchant: string; amount_str: string; date: string; guess: string | null }): string {
  const lines = items.map((it) => {
    const ctx = lineFor(it);
    const tail = ctx.guess ? `→ ${ctx.guess}?` : `→ ?`;
    if (tone === 'concise') {
      return `${it.label}: ${ctx.merchant} ${ctx.amount_str} ${ctx.date} ${tail}`;
    }
    return `${it.label}: ${ctx.merchant} · ${ctx.amount_str} · ${ctx.date} ${tail}`;
  });

  switch (tone) {
    case 'casual':
      return [
        `Three more for ya:`,
        ...lines,
        `Reply 1 to confirm all, or per item ("A 1, B groceries, C 2"). PAUSE to stop.`,
      ].join('\n');
    case 'formal':
      return [
        `Three more transactions to categorize:`,
        ...lines,
        `Reply 1 to confirm all suggestions, or per item ("A 1, B groceries, C 2"). PAUSE to pause for today.`,
      ].join('\n');
    case 'concise':
      return [
        ...lines,
        `1=all, "A x, B y, C z" per item, PAUSE`,
      ].join('\n');
  }
}

// ── Praise (replaces the random rotation in sms-praise.ts) ────────────────

export interface PraiseInputs {
  resolvedToday: number;
  streak: number;
  firstEver: boolean;
}

export function renderPraiseByTone(tone: Tone, p: PraiseInputs): string {
  if (p.firstEver) {
    switch (tone) {
      case 'casual':  return `First one — locked in. Thanks!`;
      case 'formal':  return `Got it. That's the first one — thank you.`;
      case 'concise': return `Locked in. (1st ever)`;
    }
  }
  if (p.streak >= 5) {
    switch (tone) {
      case 'casual':  return `${p.streak} in a row — you're a machine.`;
      case 'formal':  return `${p.streak} consecutive — excellent rhythm.`;
      case 'concise': return `${p.streak} in a row.`;
    }
  }
  if (p.streak >= 3) {
    switch (tone) {
      case 'casual':  return `That's ${p.streak} in a row! Nice rhythm.`;
      case 'formal':  return `${p.streak} in a row — well done.`;
      case 'concise': return `${p.streak} in a row.`;
    }
  }
  if (p.resolvedToday >= 5) {
    switch (tone) {
      case 'casual':  return `${p.resolvedToday} today — books are getting clean.`;
      case 'formal':  return `${p.resolvedToday} today. The books are catching up.`;
      case 'concise': return `${p.resolvedToday} today.`;
    }
  }
  if (p.resolvedToday >= 2) {
    switch (tone) {
      case 'casual':  return `Got it. That's ${p.resolvedToday} today.`;
      case 'formal':  return `Recorded. ${p.resolvedToday} today.`;
      case 'concise': return `${p.resolvedToday} today.`;
    }
  }
  // First confirm of the day.
  switch (tone) {
    case 'casual':  return `Got it. Thanks!`;
    case 'formal':  return `Recorded. Thank you.`;
    case 'concise': return `Saved.`;
  }
}

// ── Helpers for the renderers ──────────────────────────────────────────────

export function humanGuess(s: { category_tax: string | null; category_budget: string | null; method: Suggestion['method'] }): string | null {
  if (s.method === 'fallback' || (!s.category_tax && !s.category_budget)) return null;
  const slug = s.category_budget ?? s.category_tax;
  if (!slug) return null;
  return slug.replace(/_/g, ' ');
}
