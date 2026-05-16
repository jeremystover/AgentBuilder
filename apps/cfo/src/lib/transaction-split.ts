/**
 * Apple/Amazon receipt splitting + email-derived descriptions.
 *
 * A multi-item Apple receipt or Amazon order matched to a single bank charge
 * is replaced by one staged child raw_transactions row per item (plus a
 * "tax & fees" row when item prices don't sum to the charge). The original
 * row is kept with status 'split' for Teller dedup and never enters the
 * ledger.
 *
 * For single-item receipts and Venmo payments there is nothing to split —
 * instead the row's description is rewritten to the item name / payment memo
 * so it is readable in the review table.
 */

import type { Env } from '../types';
import { db, type Sql } from './db';
import type { AppleContext } from './email-parsers/apple';
import type { AmazonContext } from './email-parsers/amazon';
import type { EtsyContext } from './email-parsers/etsy';
import type { VenmoContext } from './email-parsers/venmo';

const MAX_DESC = 140;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_DESC ? t.slice(0, MAX_DESC).trim() : t;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Coerce a stored supplement_json value into a clean { vendor: context }
 * object. Tolerates legacy malformed shapes — a value double-encoded as a
 * JSON string, or an array like `[{}, "<json-string>"]` produced when an
 * already-stringified value was concatenated onto an empty object.
 */
export function normalizeSupplement(raw: unknown): Record<string, unknown> {
  let v: unknown = raw;
  if (typeof v === 'string') v = safeParse(v);
  if (Array.isArray(v)) {
    const merged: Record<string, unknown> = {};
    for (const el of v) {
      const obj = typeof el === 'string' ? safeParse(el) : el;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) Object.assign(merged, obj);
    }
    v = merged;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof val === 'string' ? safeParse(val) : val;
  }
  return out;
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

/**
 * Build per-item split rows for an Amazon order, or null when it can't be
 * split accurately. Amazon emails only itemize prices on the order
 * confirmation, and the scraped list can be noisy, so a split is only
 * produced when every item has a price and those prices sum to within a
 * tax+shipping margin of the charge.
 */
export function computeAmazonSplits(parentAmount: number, amazon: AmazonContext): AppleSplitRow[] | null {
  const items = amazon.items ?? [];
  if (items.length < 2) return null;
  if (!items.every(it => typeof it.price === 'number' && isFinite(it.price) && it.price > 0)) return null;

  const sign = parentAmount < 0 ? -1 : 1;
  const target = round2(Math.abs(parentAmount));
  const itemsSum = round2(items.reduce((s, it) => s + it.price!, 0));
  const remainder = round2(target - itemsSum);
  // Items can't exceed the charge, and tax+shipping shouldn't dominate it —
  // outside that band the scraped item list is untrustworthy, so don't split.
  if (remainder < -0.01 || remainder > target * 0.35) return null;

  const base = { order_id: amazon.order_id };
  const rows: AppleSplitRow[] = items.map(it => ({
    description: clip(it.name) || 'Amazon item',
    amount: round2(it.price!) * sign,
    supplement: { amazon: { ...base, item: { name: it.name, price: it.price }, split_child: true } },
  }));
  if (Math.abs(remainder) >= 0.01) {
    rows.push({
      description: 'Amazon — tax & shipping',
      amount: remainder * sign,
      supplement: { amazon: { ...base, tax_and_shipping: true, split_child: true } },
    });
  }
  return rows;
}

/**
 * Build per-item split rows for an Etsy order. Etsy receipt emails itemize
 * prices like Apple receipts, so this mirrors computeAppleSplits — a
 * "tax & shipping" row absorbs any remainder so children sum to the charge.
 */
export function computeEtsySplits(parentAmount: number, etsy: EtsyContext): AppleSplitRow[] | null {
  const items = etsy.items ?? [];
  if (items.length < 2) return null;

  const sign = parentAmount < 0 ? -1 : 1;
  const target = round2(Math.abs(parentAmount));
  const base = { order_id: etsy.order_id, shop_name: etsy.shop_name };

  const rows: AppleSplitRow[] = items.map(it => ({
    description: clip(it.name) || 'Etsy item',
    amount: round2(it.price) * sign,
    supplement: { etsy: { ...base, item: { name: it.name, price: it.price }, split_child: true } },
  }));

  const itemsSum = round2(items.reduce((s, it) => s + it.price, 0));
  const remainder = round2(target - itemsSum);
  if (Math.abs(remainder) >= 0.01) {
    rows.push({
      description: 'Etsy — tax & shipping',
      amount: remainder * sign,
      supplement: { etsy: { ...base, tax_and_shipping: true, split_child: true } },
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
  if (vendor === 'amazon') {
    const a = context as AmazonContext;
    const items = a.items ?? [];
    if (items.length === 0) return null;
    const first = clip(items[0]!.name);
    if (!first) return null;
    return items.length > 1 ? clip(`${first} +${items.length - 1} more`) : first;
  }
  if (vendor === 'etsy') {
    const e = context as EtsyContext;
    if (e.items && e.items.length === 1) {
      const name = clip(e.items[0]!.name);
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
 * Replace a matched bank row with one staged child per split row, keeping the
 * parent as status 'split'. Returns the number of children created (0 if not
 * splittable or the parent is no longer in the review queue).
 */
async function splitMatched(
  sql: Sql,
  parentRawId: string,
  merchant: string,
  parentSupplement: Record<string, unknown>,
  compute: (parentAmount: number) => AppleSplitRow[] | null,
): Promise<number> {
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

  const splits = compute(Number(parent.amount));
  if (!splits) return 0;

  await sql.begin(async (tx) => {
    for (const s of splits) {
      await tx`
        INSERT INTO raw_transactions
          (account_id, source, date, amount, description, merchant, status, supplement_json, parent_raw_id)
        VALUES (
          ${parent.account_id}, ${parent.source}, ${parent.date}, ${s.amount},
          ${s.description}, ${merchant}, 'staged', ${JSON.stringify(s.supplement)}::jsonb, ${parentRawId}
        )
      `;
    }
    await tx`
      UPDATE raw_transactions
      SET status = 'split', supplement_json = ${JSON.stringify(parentSupplement)}::jsonb
      WHERE id = ${parentRawId}
    `;
  });
  return splits.length;
}

/** Split a multi-item Apple receipt's matched bank row into per-item children. */
export async function splitApple(sql: Sql, parentRawId: string, apple: AppleContext): Promise<number> {
  return splitMatched(sql, parentRawId, 'Apple', { apple }, amt => computeAppleSplits(amt, apple));
}

/** Split a multi-item Amazon order's matched bank row into per-item children. */
export async function splitAmazon(sql: Sql, parentRawId: string, amazon: AmazonContext): Promise<number> {
  return splitMatched(sql, parentRawId, 'Amazon', { amazon }, amt => computeAmazonSplits(amt, amazon));
}

/** Split a multi-item Etsy order's matched bank row into per-item children. */
export async function splitEtsy(sql: Sql, parentRawId: string, etsy: EtsyContext): Promise<number> {
  return splitMatched(sql, parentRawId, 'Etsy', { etsy }, amt => computeEtsySplits(amt, etsy));
}

export interface BackfillResult {
  scanned: number;
  apple_split: number;
  amazon_split: number;
  etsy_split: number;
  rows_created: number;
  descriptions_updated: number;
  supplement_repaired: number;
}

/**
 * One-time backfill: re-apply splitting and Apple/Amazon/Etsy/Venmo
 * descriptions to rows that were already email-matched before this was enabled.
 * Also repairs any supplement_json that was stored in a legacy malformed
 * shape so the enrichment data is readable again. Amazon rows enriched before
 * per-item prices were parsed have no prices to split on — they get a
 * description only.
 */
export async function backfillEmailEnrichment(env: Env): Promise<BackfillResult> {
  const sql = db(env);
  try {
    // Don't filter on `supplement_json ? 'apple'` — legacy malformed rows
    // store the data in an array/string shape the `?` operator can't see.
    const rows = await sql<Array<{ id: string; supplement_json: unknown }>>`
      SELECT id, supplement_json FROM raw_transactions
      WHERE status IN ('staged', 'waiting')
        AND parent_raw_id IS NULL
        AND supplement_json IS NOT NULL
    `;
    let appleSplit = 0;
    let amazonSplit = 0;
    let etsySplit = 0;
    let rowsCreated = 0;
    let descUpdated = 0;
    let repaired = 0;

    for (const r of rows) {
      const norm = normalizeSupplement(r.supplement_json);
      const apple = norm.apple as AppleContext | undefined;
      const amazon = norm.amazon as AmazonContext | undefined;
      const etsy = norm.etsy as EtsyContext | undefined;
      const venmo = norm.venmo as VenmoContext | undefined;
      const malformed = JSON.stringify(r.supplement_json) !== JSON.stringify(norm);

      if (apple && Array.isArray(apple.items) && apple.items.length >= 2) {
        const created = await splitApple(sql, r.id, apple);
        if (created > 0) {
          appleSplit++;
          rowsCreated += created;
          continue;
        }
      }
      if (amazon && Array.isArray(amazon.items) && amazon.items.length >= 2) {
        const created = await splitAmazon(sql, r.id, amazon);
        if (created > 0) {
          amazonSplit++;
          rowsCreated += created;
          continue;
        }
      }
      if (etsy && Array.isArray(etsy.items) && etsy.items.length >= 2) {
        const created = await splitEtsy(sql, r.id, etsy);
        if (created > 0) {
          etsySplit++;
          rowsCreated += created;
          continue;
        }
      }

      const desc = apple
        ? deriveDescription('apple', apple)
        : amazon
          ? deriveDescription('amazon', amazon)
          : etsy
            ? deriveDescription('etsy', etsy)
            : venmo
              ? deriveDescription('venmo', venmo)
              : null;

      if (malformed) {
        await sql`
          UPDATE raw_transactions SET supplement_json = ${JSON.stringify(norm)}::jsonb
          WHERE id = ${r.id} AND status IN ('staged', 'waiting')
        `;
        repaired++;
      }
      if (desc) {
        await sql`
          UPDATE raw_transactions SET description = ${desc}
          WHERE id = ${r.id} AND status IN ('staged', 'waiting')
        `;
        descUpdated++;
      }
    }
    return {
      scanned: rows.length,
      apple_split: appleSplit,
      amazon_split: amazonSplit,
      etsy_split: etsySplit,
      rows_created: rowsCreated,
      descriptions_updated: descUpdated,
      supplement_repaired: repaired,
    };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
