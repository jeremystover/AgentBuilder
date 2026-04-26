/**
 * Context-aware praise messages. Phase A used a static rotation of four
 * strings; Phase B reads sms_outcomes for today and tailors the wording
 * to actual progress so "you're crushing it" lines up with reality.
 *
 * Streak = consecutive 'confirmed' or 'free_text'-resolved-to-confirm
 * outcomes today, broken by 'rerouted' or 'timed_out'. We keep the
 * streak window scoped to today so a fresh morning doesn't claim a
 * stale streak from last night.
 */

import type { Env } from '../types';
import { localNow } from './pacific-time';

interface PraiseContext {
  /** Outcomes resolved today as confirmed/free_text — counts toward "X today". */
  resolvedToday: number;
  /** Current streak of consecutive resolutions today. */
  streak: number;
  /** True if this is the first resolution we've seen for the person ever. */
  firstEver: boolean;
}

export async function fetchPraiseContext(
  env: Env,
  userId: string,
  person: 'jeremy' | 'elyse',
  timezone: string,
  now = new Date(),
): Promise<PraiseContext> {
  const today = localNow(timezone, now).dateKey;

  // Pull today's outcomes oldest-first so we can walk for streak.
  const outcomes = await env.DB.prepare(
    `SELECT action, created_at FROM sms_outcomes
     WHERE user_id = ? AND person = ?
       AND date(created_at, 'localtime') >= ?
     ORDER BY created_at ASC`,
  ).bind(userId, person, today).all<{ action: string; created_at: string }>();

  const resolvedToday = outcomes.results.filter(
    (o) => o.action === 'confirmed' || o.action === 'free_text',
  ).length;

  // Streak: walk backwards, count consecutive resolutions until a break.
  let streak = 0;
  for (let i = outcomes.results.length - 1; i >= 0; i--) {
    const action = outcomes.results[i]!.action;
    if (action === 'confirmed' || action === 'free_text') streak++;
    else break;
  }

  // First-ever check is cheap because we only care if there are zero
  // historical outcomes.
  let firstEver = false;
  if (outcomes.results.length === 0) {
    const ever = await env.DB.prepare(
      `SELECT 1 FROM sms_outcomes
       WHERE user_id = ? AND person = ?
         AND action IN ('confirmed', 'free_text') LIMIT 1`,
    ).bind(userId, person).first();
    firstEver = !ever;
  }

  return { resolvedToday, streak, firstEver };
}

export function renderPraise(ctx: PraiseContext): string {
  if (ctx.firstEver) {
    return "First one — locked in. Thank you!";
  }
  if (ctx.streak >= 5) {
    return `${ctx.streak} in a row — you're a machine.`;
  }
  if (ctx.streak >= 3) {
    return `That's ${ctx.streak} in a row! Nice rhythm.`;
  }
  if (ctx.resolvedToday >= 5) {
    return `${ctx.resolvedToday} today — books are getting clean.`;
  }
  if (ctx.resolvedToday >= 2) {
    return `Got it. That's ${ctx.resolvedToday} today.`;
  }
  // resolvedToday === 1 (just this one) — keep it simple, not braggy.
  const opts = [
    "Got it. Thank you!",
    "Nice — locked in.",
    "Saved.",
  ];
  return opts[Math.floor(Math.random() * opts.length)]!;
}

export async function praiseFor(
  env: Env,
  userId: string,
  person: 'jeremy' | 'elyse',
  timezone: string,
): Promise<string> {
  const ctx = await fetchPraiseContext(env, userId, person, timezone);
  return renderPraise(ctx);
}
