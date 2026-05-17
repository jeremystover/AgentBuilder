/**
 * Email-sync orchestrator. For each vendor:
 *   1. Find unprocessed Gmail messages matching the vendor's search query
 *   2. Parse each message via the vendor parser
 *   3. Find a matching raw_transaction (amount + date window + vendor hint)
 *   4. If matched: update raw_transactions.supplement_json with vendor context;
 *      if status was 'waiting' for this vendor, promote to 'staged'
 *   5. Record the result in email_processed (success or failure) so re-runs
 *      don't repeat the work
 *
 * Email NEVER writes to the transactions table or touches classification —
 * see apps/cfo/CLAUDE.md "Email is Gather-only."
 */

import type { Env } from '../types';
import { db, type Sql } from './db';
import { searchMessages, getMessage, type GmailMessage } from './gmail';
import { parseAmazonEmail, type AmazonContext } from './email-parsers/amazon';
import { parseVenmoEmail, type VenmoContext } from './email-parsers/venmo';
import { parseAppleEmail, type AppleContext } from './email-parsers/apple';
import { parseEtsyEmail, type EtsyContext } from './email-parsers/etsy';
import { parseEbayEmail, type EbayContext } from './email-parsers/ebay';
import {
  pickBestMatch,
  type MatchCandidate,
  type VendorHint,
} from './email-matchers/match';
import { splitApple, splitAmazon, splitEtsy, deriveDescription } from './transaction-split';

export const VENDORS: readonly VendorHint[] = ['amazon', 'venmo', 'apple', 'etsy', 'ebay'] as const;

const SEARCH_QUERIES: Record<VendorHint, string> = {
  amazon: 'from:(auto-confirm@amazon.com OR ship-confirm@amazon.com OR shipment-tracking@amazon.com OR order-update@amazon.com) subject:"Your Amazon.com order" newer_than:24m',
  venmo:  'from:venmo@venmo.com newer_than:24m',
  apple:  'subject:"receipt from Apple" newer_than:24m',
  etsy:   '(from:(transaction@etsy.com OR support@etsy.com) OR subject:etsy) newer_than:24m',
  ebay:   'from:ebay@ebay.com subject:"Order confirmed" newer_than:24m',
};

const SOURCE_FOR_VENDOR: Record<VendorHint, 'email_amazon' | 'email_venmo' | 'email_apple' | 'email_etsy' | 'email_ebay'> = {
  amazon: 'email_amazon',
  venmo:  'email_venmo',
  apple:  'email_apple',
  etsy:   'email_etsy',
  ebay:   'email_ebay',
};

export interface VendorSyncResult {
  vendor: VendorHint;
  scanned: number;
  parsed: number;
  matched: number;
  errors: number;
  skipped_already_processed: number;
}

export interface EmailSyncResult {
  results: VendorSyncResult[];
  ran_at: string;
}

export async function runEmailSync(
  env: Env,
  vendors?: VendorHint[],
  onProgress?: (event: object) => void,
): Promise<EmailSyncResult> {
  const targets = vendors ?? VENDORS;
  const ranAt = new Date().toISOString();
  const sql = db(env);
  onProgress?.({ type: 'start', total: targets.length });
  try {
    const results: VendorSyncResult[] = [];
    for (const [idx, vendor] of targets.entries()) {
      const source = SOURCE_FOR_VENDOR[vendor];
      onProgress?.({ type: 'vendor_start', index: idx, total: targets.length, vendor });
      const logRows = await sql<Array<{ id: string }>>`
        INSERT INTO sync_log (source, status) VALUES (${source}, 'running') RETURNING id
      `;
      const syncId = logRows[0]!.id;
      try {
        const result = await syncVendor(env, sql, vendor);
        results.push(result);
        onProgress?.({ type: 'vendor_ok', index: idx, total: targets.length, vendor, scanned: result.scanned, matched: result.matched });
        await sql`
          UPDATE sync_log
          SET status = 'completed', completed_at = now(),
              transactions_found = ${result.scanned}, transactions_new = ${result.matched}
          WHERE id = ${syncId}
        `;
      } catch (err) {
        onProgress?.({
          type: 'vendor_err',
          index: idx,
          total: targets.length,
          vendor,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        results.push({ vendor, scanned: 0, parsed: 0, matched: 0, errors: 1, skipped_already_processed: 0 });
        await sql`
          UPDATE sync_log
          SET status = 'failed', completed_at = now(), error_message = ${String(err)}
          WHERE id = ${syncId}
        `;
      }
    }
    return { results, ran_at: ranAt };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// Enough headroom for 24 months of a vendor's emails — the default 200 cap
// truncates high-volume senders like Amazon to the most recent ~6 months.
const VENDOR_SEARCH_CAP = 1500;

async function syncVendor(env: Env, sql: Sql, vendor: VendorHint): Promise<VendorSyncResult> {
  const refs = await searchMessages(env, SEARCH_QUERIES[vendor], VENDOR_SEARCH_CAP);

  let parsed = 0;
  let matched = 0;
  let errors = 0;
  let skipped = 0;

  for (const ref of refs) {
    const already = await sql<Array<{ message_id: string }>>`
      SELECT message_id FROM email_processed
      WHERE vendor = ${vendor} AND message_id = ${ref.id}
      LIMIT 1
    `;
    if (already.length > 0) {
      skipped++;
      continue;
    }

    let message: GmailMessage;
    try {
      message = await getMessage(env, ref.id);
    } catch (err) {
      errors++;
      await recordProcessed(sql, vendor, ref.id, { parse_success: false, error: String(err) });
      continue;
    }

    const context = parseMessage(vendor, message);
    if (!context) {
      await recordProcessed(sql, vendor, ref.id, {
        parse_success: false,
        error: 'parser returned null',
      });
      continue;
    }
    parsed++;

    const matchResult = await findMatch(sql, vendor, context);
    if (matchResult) {
      matched++;
      const parentId = matchResult.transaction_id;
      const split = vendor === 'apple'
        ? await splitApple(sql, parentId, context as AppleContext)
        : vendor === 'amazon'
          ? await splitAmazon(sql, parentId, context as AmazonContext)
          : vendor === 'etsy'
            ? await splitEtsy(sql, parentId, context as EtsyContext)
            : 0;
      if (split === 0) {
        await updateSupplement(sql, vendor, parentId, context);
        const desc = deriveDescription(vendor, context);
        if (desc) {
          await sql`
            UPDATE raw_transactions SET description = ${desc}
            WHERE id = ${parentId} AND status IN ('staged', 'waiting')
          `;
        }
      }
      await recordProcessed(sql, vendor, ref.id, {
        parse_success: true,
        match_found: true,
        transaction_id: parentId,
      });
    } else {
      await recordProcessed(sql, vendor, ref.id, {
        parse_success: true,
        match_found: false,
      });
    }
  }

  return {
    vendor,
    scanned: refs.length,
    parsed,
    matched,
    errors,
    skipped_already_processed: skipped,
  };
}

type VendorContext = AmazonContext | VenmoContext | AppleContext | EtsyContext | EbayContext;

function parseMessage(vendor: VendorHint, message: GmailMessage): VendorContext | null {
  switch (vendor) {
    case 'amazon': return parseAmazonEmail(message);
    case 'venmo':  return parseVenmoEmail(message);
    case 'apple':  return parseAppleEmail(message);
    case 'etsy':   return parseEtsyEmail(message);
    case 'ebay':   return parseEbayEmail(message);
  }
}

function amountAndDateFor(vendor: VendorHint, context: VendorContext): { amount: number; date: string } | null {
  switch (vendor) {
    case 'amazon': {
      const c = context as AmazonContext;
      if (c.total_amount === null) return null;
      return { amount: c.total_amount, date: c.shipment_date ?? c.order_date ?? '' };
    }
    case 'venmo': {
      const c = context as VenmoContext;
      return { amount: c.amount, date: c.date };
    }
    case 'apple': {
      const c = context as AppleContext;
      return { amount: c.total_amount, date: c.date };
    }
    case 'etsy': {
      const c = context as EtsyContext;
      return { amount: c.total_amount, date: c.date };
    }
    case 'ebay': {
      const c = context as EbayContext;
      if (c.total_amount === null) return null;
      return { amount: c.total_amount, date: c.date };
    }
  }
}

function windowDaysFor(vendor: VendorHint, context: VendorContext): { back: number; forward: number } {
  if (vendor === 'amazon' || vendor === 'ebay') return { back: 2, forward: 12 };
  if (vendor === 'etsy') {
    const c = context as EtsyContext;
    return c.date_is_from_body ? { back: 2, forward: 5 } : { back: 60, forward: 5 };
  }
  if (vendor === 'apple') {
    const c = context as AppleContext;
    return c.date_is_from_body ? { back: 2, forward: 5 } : { back: 60, forward: 5 };
  }
  return { back: 2, forward: 2 }; // venmo
}

async function findMatch(sql: Sql, vendor: VendorHint, context: VendorContext) {
  const ad = amountAndDateFor(vendor, context);
  if (!ad || !ad.date) return null;

  const { back, forward } = windowDaysFor(vendor, context);
  const dateFrom = shiftIsoDate(ad.date, -back);
  const dateTo = shiftIsoDate(ad.date, forward);

  // Candidate raw_transactions are Teller-sourced rows within the date window
  // whose absolute amount matches (within $0.01). Sign differs by account type
  // (credit card vs. bank) so we match on |amount|.
  const candidates = await sql<Array<{
    transaction_id: string;
    date: string;
    amount: string;
    description: string;
  }>>`
    SELECT id AS transaction_id,
           to_char(date, 'YYYY-MM-DD') AS date,
           amount::text AS amount,
           description
    FROM raw_transactions
    WHERE source = 'teller'
      AND date BETWEEN ${dateFrom} AND ${dateTo}
      AND ABS(ABS(amount) - ${ad.amount}) < 0.01
  `;

  const matchCandidates: MatchCandidate[] = candidates.map(c => ({
    transaction_id: c.transaction_id,
    date: c.date,
    amount: Number(c.amount),
    description: c.description,
  }));

  return pickBestMatch({
    candidates: matchCandidates,
    parsed: ad,
    vendor,
  });
}

async function updateSupplement(
  sql: Sql,
  vendor: VendorHint,
  transactionId: string,
  context: VendorContext,
): Promise<void> {
  const supplement = { [vendor]: context };
  const expectedWaiting = SOURCE_FOR_VENDOR[vendor];
  // Merge into supplement_json; if the row was waiting for THIS vendor, promote it.
  // The CASE guards against a legacy non-object supplement_json (a value that
  // was stored double-encoded) — `array || object` would append, not merge.
  await sql`
    UPDATE raw_transactions
    SET supplement_json = (
          CASE WHEN jsonb_typeof(supplement_json) = 'object'
               THEN supplement_json ELSE '{}'::jsonb END
        ) || ${JSON.stringify(supplement)}::jsonb,
        status = CASE
          WHEN status = 'waiting' AND waiting_for = ${expectedWaiting} THEN 'staged'
          ELSE status
        END,
        waiting_for = CASE
          WHEN status = 'waiting' AND waiting_for = ${expectedWaiting} THEN NULL
          ELSE waiting_for
        END
    WHERE id = ${transactionId}
  `;
}

interface RecordOpts {
  parse_success: boolean;
  match_found?: boolean;
  transaction_id?: string;
  error?: string;
}

async function recordProcessed(
  sql: Sql,
  vendor: VendorHint,
  messageId: string,
  opts: RecordOpts,
): Promise<void> {
  await sql`
    INSERT INTO email_processed (vendor, message_id, parse_success, match_found, transaction_id, error_message)
    VALUES (
      ${vendor},
      ${messageId},
      ${opts.parse_success},
      ${opts.match_found ?? false},
      ${opts.transaction_id ?? null},
      ${opts.error ?? null}
    )
    ON CONFLICT (vendor, message_id) DO NOTHING
  `;
}

function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface EmailStatus {
  per_vendor: Array<{
    vendor: VendorHint;
    last_processed_at: string | null;
    total_processed: number;
    parse_failures: number;
    unmatched: number;
  }>;
}

export async function getEmailStatus(env: Env): Promise<EmailStatus> {
  const sql = db(env);
  try {
    const rows = await sql<Array<{
      vendor: VendorHint;
      last_processed_at: string | null;
      total_processed: string;
      parse_failures: string;
      unmatched: string;
    }>>`
      SELECT vendor,
             MAX(processed_at) AS last_processed_at,
             COUNT(*) AS total_processed,
             COUNT(*) FILTER (WHERE parse_success = false) AS parse_failures,
             COUNT(*) FILTER (WHERE parse_success = true AND match_found = false) AS unmatched
      FROM email_processed
      GROUP BY vendor
    `;
    const byVendor = new Map(rows.map(r => [r.vendor, r]));
    return {
      per_vendor: VENDORS.map(v => {
        const row = byVendor.get(v);
        return {
          vendor: v,
          last_processed_at: row?.last_processed_at ?? null,
          total_processed: Number(row?.total_processed ?? 0),
          parse_failures: Number(row?.parse_failures ?? 0),
          unmatched: Number(row?.unmatched ?? 0),
        };
      }),
    };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
