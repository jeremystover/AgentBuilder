/**
 * Apple receipt splitting + email-derived descriptions.
 *
 * A multi-item Apple receipt matched to a single bank charge is replaced by
 * one staged child raw_transactions row per item (plus a "tax & fees" row
 * when item prices don't sum to the charge). The original row is kept with
 * status 'split' for Teller dedup and never enters the ledger.
 *
 * For single-item Apple receipts and Venmo payments there is nothing to
 * split — instead the row's description is rewritten to the item name /
 * payment memo so it is readable in the review table.
 */

import type { Env } from '../types';
import { db, type Sql } from './db';
import type { AppleContext } from './email-parsers/apple';
import type { VenmoContext } from './email-parsers/venmo';

const MAX_DESC = 140;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_DESC ? t.slice(0, MAX_DESC).trim() : t;
}

/** Best-effort cleanup of noisy Apple item names from receipt HTML. */
export function cleanItemName(raw: string): string {
  let s = (raw ?? '')
    .replace(/\bRenews\b[\s\S]*$/i, '')
    .replace(/\bReport a Problem\b/gi, '')
    .replace(/\bWrite a Review\b/gi, '')
    .replace(/\bIn-App Purchase\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Receipt HTML often repeats the title in two cells: "Title Title".
  const dup = s.match(/^(.+?)\s+\1$/);
  if (dup) s = dup[1]!.trim();
  return clip(s);
}

export interface AppleSplitRow {
  description: string;
  amount: number; // signed to match the parent charge
  supplement: Record<string, unknown>;
}

/**
 * Build per-item split rows for an Apple receipt, or null if the receipt has
 * fewer than 2 items (nothing to split). When item prices don't sum to the
 * charged amount, a "tax & fees" row absorbs the remainder so the children
 * always sum back to the original charge.
 */
export function computeAppleSplits(parentAmount: number, apple: AppleContext): AppleSplitRow[] | null {
  const items = apple.items ?? [];
  if (items.length < 2) return null;

  const sign = parentAmount < 0 ? -1 : 1;
  const target = round2(Math.abs(parentAmount));
  const base = { receipt_id: apple.receipt_id, date: apple.date };

  const rows: AppleSplitRow[] = items.map(it => ({
    description: cleanItemName(it.name) || 'Apple item',
    amount: round2(it.price) * sign,
    supplement: { apple: { ...base, item: { name: it.name, price: it.price }, split_child: true } },
  }));

  const itemsSum = round2(items.reduce((s, it) => s + it.price, 0));
  const remainder = round2(target - itemsSum);
  if (Math.abs(remainder) >= 0.01) {
    rows.push({
      description: 'Apple — tax & fees',
      amount: remainder * sign,
      supplement: { apple: { ...base, tax_and_fees: true, split_child: true } },
    });
  }
  return rows;
}

/** A readable description from email enrichment, or null to keep the bank one. */
export function deriveDescription(vendor: string, context: unknown): string | null {
  if (vendor === 'apple') {
    const a = context as AppleContext;
    if (a.items && a.items.length === 1) {
      const name = cleanItemName(a.items[0]!.name);
      return name || null;
    }
    return null;
  }
  if (vendor === 'venmo') {
    const v = context as VenmoContext;
    const d = (v.memo && v.memo.trim()) || v.counterparty;
    return d ? clip(d) : null;
  }
  return null;
}

/**
 * Split a multi-item Apple receipt's matched bank row into per-item children.
 * Returns the number of children created (0 if not splittable or the parent
 * is no longer in the review queue).
 */
export async function splitApple(sql: Sql, parentRawId: string, apple: AppleContext): Promise<number> {
  const parentRows = await sql<Array<{
    account_id: string | null;
    source: string;
    date: string;
    amount: string;
    status: string;
  }>>`
    SELECT account_id, source, to_char(date, 'YYYY-MM-DD') AS date, amount::text AS amount, status
    FROM raw_transactions WHERE id = ${parentRawId}
  `;
  const parent = parentRows[0];
  if (!parent) return 0;
  if (parent.status !== 'staged' && parent.status !== 'waiting') return 0;

  const splits = computeAppleSplits(Number(parent.amount), apple);
  if (!splits) return 0;

  await sql.begin(async (tx) => {
    for (const s of splits) {
      await tx`
        INSERT INTO raw_transactions
          (account_id, source, date, amount, description, merchant, status, supplement_json, parent_raw_id)
        VALUES (
          ${parent.account_id}, ${parent.source}, ${parent.date}, ${s.amount},
          ${s.description}, 'Apple', 'staged', ${JSON.stringify(s.supplement)}::jsonb, ${parentRawId}
        )
      `;
    }
    await tx`
      UPDATE raw_transactions
      SET status = 'split',
          supplement_json = COALESCE(supplement_json, '{}'::jsonb) || ${JSON.stringify({ apple })}::jsonb
      WHERE id = ${parentRawId}
    `;
  });
  return splits.length;
}

export interface BackfillResult {
  apple_split: number;
  rows_created: number;
  descriptions_updated: number;
}

/**
 * One-time backfill: re-apply Apple splitting and Apple/Venmo descriptions to
 * review-queue rows that were already email-matched before this was enabled.
 */
export async function backfillEmailEnrichment(env: Env): Promise<BackfillResult> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string; supplement_json: Record<string, unknown> | null }>>`
      SELECT id, supplement_json FROM raw_transactions
      WHERE status IN ('staged', 'waiting')
        AND parent_raw_id IS NULL
        AND (supplement_json ? 'apple' OR supplement_json ? 'venmo')
    `;
    let appleSplit = 0;
    let rowsCreated = 0;
    let descUpdated = 0;

    for (const r of rows) {
      const sup = r.supplement_json ?? {};
      const apple = sup.apple as AppleContext | undefined;
      const venmo = sup.venmo as VenmoContext | undefined;

      if (apple) {
        const created = await splitApple(sql, r.id, apple);
        if (created > 0) {
          appleSplit++;
          rowsCreated += created;
          continue;
        }
      }
      const desc = apple
        ? deriveDescription('apple', apple)
        : venmo
          ? deriveDescription('venmo', venmo)
          : null;
      if (desc) {
        await sql`
          UPDATE raw_transactions SET description = ${desc}
          WHERE id = ${r.id} AND status IN ('staged', 'waiting')
        `;
        descUpdated++;
      }
    }
    return { apple_split: appleSplit, rows_created: rowsCreated, descriptions_updated: descUpdated };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
