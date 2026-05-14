/**
 * Tax & Profile configuration routes (Module 5, Phase 6 step 7).
 *
 *   GET    /api/web/profiles                       list user profiles
 *   PUT    /api/web/profiles/:id                   update DOB + retirement date
 *   GET    /api/web/state-timeline                 list state residence rows
 *   PUT    /api/web/state-timeline                 replace timeline (array)
 *   GET    /api/web/tax-brackets                   list bracket schedules
 *   POST   /api/web/tax-brackets                   add/replace a (year, status, juris) row
 *   GET    /api/web/deductions                     list deduction rows
 *   PUT    /api/web/deductions                     replace deduction rows
 *
 * Bracket data is JSON in the database; the UI sends it as JSON too.
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';

// ── User profiles ────────────────────────────────────────────────────────────

export async function handleListProfiles(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, name, role,
             to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
             to_char(expected_retirement_date, 'YYYY-MM-DD') AS expected_retirement_date
      FROM user_profiles
      ORDER BY role, name
    `;
    return jsonOk({ profiles: rows });
  } catch (err) {
    return jsonError(`list profiles failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface ProfileBody { date_of_birth?: string; expected_retirement_date?: string | null }

export async function handleUpdateProfile(req: Request, env: Env, id: string): Promise<Response> {
  const body = await req.json().catch(() => null) as ProfileBody | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    if ('date_of_birth' in body && body.date_of_birth) {
      await sql`UPDATE user_profiles SET date_of_birth = ${body.date_of_birth} WHERE id = ${id}`;
    }
    if ('expected_retirement_date' in body) {
      await sql`UPDATE user_profiles SET expected_retirement_date = ${body.expected_retirement_date ?? null} WHERE id = ${id}`;
    }
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update profile failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── State timeline ───────────────────────────────────────────────────────────

export async function handleGetStateTimeline(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string; state: string; effective_date: string }>>`
      SELECT id, state, to_char(effective_date, 'YYYY-MM-DD') AS effective_date
      FROM state_residence_timeline
      ORDER BY effective_date
    `;
    return jsonOk({ entries: rows });
  } catch (err) {
    return jsonError(`get state timeline failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface StateTimelineBody { entries: Array<{ state: string; effective_date: string }> }

export async function handlePutStateTimeline(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as StateTimelineBody | null;
  if (!body || !Array.isArray(body.entries)) return jsonError('entries array required', 400);
  const sql = db(env);
  try {
    await sql.begin(async tx => {
      await tx`DELETE FROM state_residence_timeline`;
      for (const e of body.entries) {
        await tx`INSERT INTO state_residence_timeline (state, effective_date) VALUES (${e.state}, ${e.effective_date})`;
      }
    });
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update state timeline failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Tax brackets ─────────────────────────────────────────────────────────────

export async function handleListTaxBrackets(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, year, filing_status, jurisdiction, brackets_json,
             standard_deduction::text AS standard_deduction, created_by
      FROM tax_bracket_schedules
      ORDER BY year DESC, jurisdiction, filing_status
    `;
    return jsonOk({
      brackets: rows.map(r => ({
        ...r,
        standard_deduction: r.standard_deduction == null ? null : Number(r.standard_deduction),
      })),
    });
  } catch (err) {
    return jsonError(`list tax brackets failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface TaxBracketBody {
  year: number;
  filing_status: string;
  jurisdiction: string;
  brackets: Array<{ floor: number; ceiling: number | null; rate: number }>;
  standard_deduction: number | null;
}

export async function handleUpsertTaxBracket(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as TaxBracketBody | null;
  if (!body) return jsonError('invalid body', 400);
  const sql = db(env);
  try {
    await sql`
      INSERT INTO tax_bracket_schedules (year, filing_status, jurisdiction, brackets_json, standard_deduction, created_by)
      VALUES (${body.year}, ${body.filing_status}, ${body.jurisdiction},
              ${JSON.stringify(body.brackets)}::jsonb, ${body.standard_deduction ?? null}, 'user')
      ON CONFLICT (year, filing_status, jurisdiction) DO UPDATE SET
        brackets_json      = EXCLUDED.brackets_json,
        standard_deduction = EXCLUDED.standard_deduction,
        created_by         = 'user'
    `;
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`upsert tax bracket failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── Deductions ───────────────────────────────────────────────────────────────

export async function handleListDeductions(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT id, type, label,
             annual_amount::text AS annual_amount,
             to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
             source
      FROM tax_deduction_config
      ORDER BY effective_date DESC, type
    `;
    return jsonOk({
      deductions: rows.map(r => ({ ...r, annual_amount: Number(r.annual_amount) })),
    });
  } catch (err) {
    return jsonError(`list deductions failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

interface DeductionEntry {
  type: 'salt' | 'charitable' | 'mortgage_interest' | 'other';
  label?: string | null;
  annual_amount: number;
  effective_date: string;
  source?: 'manual' | 'auto_mortgage';
}

export async function handlePutDeductions(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as { entries: DeductionEntry[] } | null;
  if (!body || !Array.isArray(body.entries)) return jsonError('entries array required', 400);
  const sql = db(env);
  try {
    await sql.begin(async tx => {
      await tx`DELETE FROM tax_deduction_config`;
      for (const e of body.entries) {
        await tx`
          INSERT INTO tax_deduction_config (type, label, annual_amount, effective_date, source)
          VALUES (${e.type}, ${e.label ?? null}, ${e.annual_amount}, ${e.effective_date}, ${e.source ?? 'manual'})
        `;
      }
    });
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(`update deductions failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
