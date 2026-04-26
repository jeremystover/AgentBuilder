/**
 * Context-aware praise messages.
 *
 * Streak = consecutive 'confirmed' or 'free_text'-resolved-to-confirm
 * outcomes today, broken by 'rerouted' or 'timed_out'. We keep the
 * streak window scoped to today so a fresh morning doesn't claim a
 * stale streak from last night.
 *
 * Phase C: tone is selected from the session's variant_id (or
 * recomputed from the day's deterministic variant if the session
 * doesn't have one, e.g. legacy data). Falls back to 'casual' if no
 * variant resolves.
 */

import type { Env } from '../types';
import { localNow } from './pacific-time';
import { VARIANTS, pickVariant, renderPraiseByTone, type Tone, type PraiseInputs } from './sms-variants';

export async function fetchPraiseContext(
  env: Env,
  userId: string,
  person: 'jeremy' | 'elyse',
  timezone: string,
  now = new Date(),
): Promise<PraiseInputs> {
  const today = localNow(timezone, now).dateKey;

  const outcomes = await env.DB.prepare(
    `SELECT action, created_at FROM sms_outcomes
     WHERE user_id = ? AND person = ?
       AND date(created_at, 'localtime') >= ?
     ORDER BY created_at ASC`,
  ).bind(userId, person, today).all<{ action: string; created_at: string }>();

  const resolvedToday = outcomes.results.filter(
    (o) => o.action === 'confirmed' || o.action === 'free_text',
  ).length;

  let streak = 0;
  for (let i = outcomes.results.length - 1; i >= 0; i--) {
    const action = outcomes.results[i]!.action;
    if (action === 'confirmed' || action === 'free_text') streak++;
    else break;
  }

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

/** Praise tied to the variant ID we recorded when the session opened. */
export async function praiseFor(
  env: Env,
  userId: string,
  person: 'jeremy' | 'elyse',
  timezone: string,
  variantId?: string | null,
): Promise<string> {
  const ctx = await fetchPraiseContext(env, userId, person, timezone);
  const tone = resolveTone(variantId, person, timezone);
  return renderPraiseByTone(tone, ctx);
}

function resolveTone(variantId: string | null | undefined, person: 'jeremy' | 'elyse', timezone: string): Tone {
  if (variantId) {
    const found = VARIANTS.find((v) => v.id === variantId);
    if (found) return found.tone;
  }
  // Fallback: recompute today's variant. Keeps Phase A/B sessions
  // (no variant_id stored) from breaking on praise.
  return pickVariant(person, localNow(timezone).dateKey).tone;
}
