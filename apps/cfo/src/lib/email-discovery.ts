/**
 * Reverse email enrichment ("discovery").
 *
 * The forward flow (email-sync.ts) starts from a known vendor's emails.
 * Discovery starts from an un-enriched Teller transaction we can't identify,
 * searches Gmail for an email about it, and asks an LLM to confirm the match
 * and write a readable description. This captures arbitrary vendors (travel,
 * rideshare, etc.) without a per-vendor parser.
 */

import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../types';
import { db, type Sql } from './db';
import { searchMessages, getMessage, getMessageBody, getHeader } from './gmail';

const MAX_CANDIDATES = 5;
const DEFAULT_BATCH = 40;
const BODY_CHARS = 600;
const MAX_DESC = 140;

const NOISE_WORDS = new Set([
  'purchase', 'payment', 'pos', 'debit', 'credit', 'recurring', 'ach', 'web',
  'id', 'ref', 'inc', 'llc', 'co', 'com', 'the', 'and', 'bill', 'online',
]);

interface RawTxn {
  id: string;
  date: string;
  amount: number;
  description: string;
  merchant: string | null;
}

interface Candidate {
  message_id: string;
  subject: string;
  from: string;
  date: string;
  body: string;
}

export interface DiscoveryMatch {
  matched: boolean;
  email_number: number | null;
  description: string | null;
  confidence: 'high' | 'medium' | 'low';
}

export interface DiscoveryResult {
  scanned: number;
  matched: number;
  no_email: number;
  no_match: number;
  errors: number;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_DESC ? t.slice(0, MAX_DESC).trim() : t;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Reduce a noisy bank descriptor to a short merchant token for a Gmail
 * search. Prefers the Teller counterparty name when present — it is already
 * close to the real merchant — and otherwise strips ref/store numbers and
 * processor noise out of the raw descriptor.
 */
export function merchantQuery(merchant: string | null, description: string): string | null {
  const raw = (merchant && merchant.trim()) || description || '';
  const words = raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !NOISE_WORDS.has(w));
  const picked = words.slice(0, 3);
  return picked.length > 0 ? picked.join(' ') : null;
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Parse the LLM's discovery JSON, tolerating ```json fences and stray prose. */
export function parseDiscoveryResponse(raw: string): DiscoveryMatch | null {
  const fenced = raw.match(/\{[\s\S]*\}/);
  if (!fenced) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(fenced[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const conf = obj.confidence;
  return {
    matched: obj.matched === true,
    email_number: typeof obj.email_number === 'number' ? obj.email_number : null,
    description: typeof obj.description === 'string' && obj.description.trim()
      ? clip(obj.description)
      : null,
    confidence: conf === 'high' || conf === 'medium' ? conf : 'low',
  };
}

const SYSTEM = `You identify what a bank transaction was for by matching it to one of the user's emails.

Given one transaction and a numbered list of candidate emails, decide which email (if any) is about that exact purchase, then write a short human-readable description of what was bought.

Return ONLY this JSON, no prose:
{"matched": true|false, "email_number": <number or null>, "description": "<short description or null>", "confidence": "high"|"medium"|"low"}

Rules:
- Match only if an email clearly concerns the same purchase — merchant, amount, and/or date should align. The exact charge amount appearing in the email is the strongest signal.
- description: concise and specific, e.g. "VRBO — beach house in Destin, FL" or "Uber ride, downtown Austin". Max ~80 characters. Null when matched is false.
- If no candidate clearly matches, return matched=false with confidence "low".`;

function buildPrompt(txn: RawTxn, candidates: Candidate[]): string {
  const lines = [
    'TRANSACTION',
    `date: ${txn.date}`,
    `amount: $${Math.abs(txn.amount).toFixed(2)}`,
    `descriptor: ${txn.description}`,
    txn.merchant ? `merchant: ${txn.merchant}` : '',
    '',
    'CANDIDATE EMAILS',
  ];
  candidates.forEach((c, i) => {
    lines.push(`[${i + 1}] date: ${c.date} | from: ${c.from} | subject: ${c.subject}`);
    lines.push(c.body);
    lines.push('');
  });
  return lines.filter(l => l !== undefined).join('\n');
}

async function gatherCandidates(env: Env, txn: RawTxn, query: string): Promise<Candidate[]> {
  const gmailQuery = `${query} after:${shiftDate(txn.date, -120).replace(/-/g, '/')} before:${shiftDate(txn.date, 8).replace(/-/g, '/')}`;
  const refs = await searchMessages(env, gmailQuery, MAX_CANDIDATES);
  const candidates: Candidate[] = [];
  for (const ref of refs.slice(0, MAX_CANDIDATES)) {
    const message = await getMessage(env, ref.id);
    const { text, html } = getMessageBody(message);
    const body = (text || stripHtml(html)).slice(0, BODY_CHARS);
    candidates.push({
      message_id: ref.id,
      subject: getHeader(message, 'subject'),
      from: getHeader(message, 'from'),
      date: new Date(parseInt(message.internalDate, 10)).toISOString().slice(0, 10),
      body,
    });
  }
  return candidates;
}

async function discoverOne(env: Env, sql: Sql, llm: LLMClient, txn: RawTxn): Promise<keyof Omit<DiscoveryResult, 'scanned'>> {
  const markSearched = () => sql`UPDATE raw_transactions SET email_search_at = now() WHERE id = ${txn.id}`;

  const query = merchantQuery(txn.merchant, txn.description);
  if (!query) {
    await markSearched();
    return 'no_email';
  }

  const candidates = await gatherCandidates(env, txn, query);
  if (candidates.length === 0) {
    await markSearched();
    return 'no_email';
  }

  const resp = await llm.complete({
    tier: 'fast',
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(txn, candidates) }] }],
    maxOutputTokens: 300,
  });
  const match = parseDiscoveryResponse(resp.text);

  const idx = match && match.email_number !== null ? match.email_number - 1 : -1;
  const chosen = idx >= 0 && idx < candidates.length ? candidates[idx]! : null;

  if (!match || !match.matched || !chosen || !match.description || match.confidence === 'low') {
    await markSearched();
    return 'no_match';
  }

  const supplement = {
    email_match: {
      message_id: chosen.message_id,
      subject: chosen.subject,
      from: chosen.from,
      email_date: chosen.date,
      description: match.description,
      confidence: match.confidence,
      found_via: 'discovery',
    },
  };
  await sql`
    UPDATE raw_transactions
    SET description = ${match.description},
        supplement_json = (
          CASE WHEN jsonb_typeof(supplement_json) = 'object'
               THEN supplement_json ELSE '{}'::jsonb END
        ) || ${JSON.stringify(supplement)}::jsonb,
        email_search_at = now()
    WHERE id = ${txn.id}
  `;
  return 'matched';
}

/**
 * Search Gmail for emails explaining un-enriched Teller transactions and
 * enrich them via an LLM. Pass `transactionId` to (re-)run a single
 * transaction, or `limit` to cap the automatic batch.
 */
export async function runEmailDiscovery(
  env: Env,
  opts?: { limit?: number; transactionId?: string },
): Promise<DiscoveryResult> {
  const sql = db(env);
  const result: DiscoveryResult = { scanned: 0, matched: 0, no_email: 0, no_match: 0, errors: 0 };
  try {
    const rows = opts?.transactionId
      ? await sql<RawTxn[]>`
          SELECT id, to_char(date, 'YYYY-MM-DD') AS date, amount::float8 AS amount, description, merchant
          FROM raw_transactions WHERE id = ${opts.transactionId}
        `
      : await sql<RawTxn[]>`
          SELECT id, to_char(date, 'YYYY-MM-DD') AS date, amount::float8 AS amount, description, merchant
          FROM raw_transactions
          WHERE source = 'teller' AND status = 'staged'
            AND supplement_json IS NULL AND email_search_at IS NULL
          ORDER BY date DESC
          LIMIT ${opts?.limit ?? DEFAULT_BATCH}
        `;

    const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY });
    for (const txn of rows) {
      result.scanned++;
      try {
        const outcome = await discoverOne(env, sql, llm, txn);
        result[outcome]++;
      } catch (err) {
        console.warn('[email-discovery] failed for', txn.id, err);
        result.errors++;
        await sql`UPDATE raw_transactions SET email_search_at = now() WHERE id = ${txn.id}`.catch(() => {});
      }
    }
    return result;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
