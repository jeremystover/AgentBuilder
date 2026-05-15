/**
 * Extension surface for the WF check extractor (and any other bank
 * extension we add later). Two responsibilities:
 *
 *   1. Help the extension *learn* how to scrape a bank page —
 *      /analyze-page accepts sanitized DOM and asks Claude where the
 *      check rows / view-check buttons / image modals live.
 *
 *   2. Receive captured check images — /check-images stores image bytes
 *      in R2, inserts a row in `check_images`, and enqueues a job to do
 *      the vision OCR + transaction matching off the request path.
 *
 * Authed with the existing 'api' surface (cookie OR Bearer EXTERNAL_API_KEY).
 */

import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';
import type { CheckQueueMessage } from '../lib/check-vision';

// ── /accounts ─────────────────────────────────────────────────────────────

export async function handleExtensionListAccounts(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    const accounts = await sql<Array<{
      id: string; name: string; institution: string | null; type: string;
    }>>`
      SELECT id, name, institution, type
      FROM gather_accounts
      WHERE is_active = true
      ORDER BY institution NULLS LAST, name
    `;
    return jsonOk({ accounts });
  } catch (err) {
    return jsonError(`list accounts failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ── /analyze-page ─────────────────────────────────────────────────────────

type AnalyzePurpose = 'account-detail-page' | 'check-modal';

interface AnalyzeBody {
  purpose: AnalyzePurpose;
  url?: string;
  /** Sanitized HTML — text content stripped, structure + class/aria/data attrs preserved. */
  html: string;
}

interface AccountDetailSelectors {
  rowSelector: string;
  viewCheckButtonSelector: string;
  checkNumberSelector: string;
  dateSelector: string;
  amountSelector: string;
  notes: string;
}

interface CheckModalSelectors {
  modalSelector: string;
  frontImageSelector: string;
  backImageToggleSelector: string | null;
  backImageSelector: string | null;
  closeSelector: string | null;
  notes: string;
}

const ANALYZE_HTML_BYTES_MAX = 200_000;

export async function handleExtensionAnalyzePage(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as AnalyzeBody | null;
  if (!body || !body.html || !body.purpose) {
    return jsonError('invalid body — needs { purpose, html }', 400);
  }
  if (body.purpose !== 'account-detail-page' && body.purpose !== 'check-modal') {
    return jsonError(`unknown purpose: ${body.purpose}`, 400);
  }
  if (body.html.length > ANALYZE_HTML_BYTES_MAX) {
    return jsonError(`html too large (${body.html.length} > ${ANALYZE_HTML_BYTES_MAX} bytes)`, 413);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonError('ANTHROPIC_API_KEY not configured', 500);
  }

  const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY });

  const system = body.purpose === 'account-detail-page'
    ? SYSTEM_ACCOUNT_DETAIL
    : SYSTEM_CHECK_MODAL;

  const userMsg = [
    body.url ? `URL: ${body.url}` : '',
    'Sanitized HTML (text content stripped, structure + class/id/role/aria/data attrs preserved):',
    '```html',
    body.html,
    '```',
    '',
    'Respond with ONLY the JSON object specified in the system prompt. No prose, no code fences.',
  ].filter(Boolean).join('\n');

  let responseText: string;
  try {
    const response = await llm.complete({
      tier: 'default',
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxOutputTokens: 800,
    });
    responseText = response.text;
  } catch (err) {
    return jsonError(`llm call failed: ${String(err)}`, 502);
  }

  const parsed = parseJsonFromText(responseText);
  if (!parsed) {
    return jsonError(`could not parse llm response: ${responseText.slice(0, 300)}`, 502);
  }

  if (body.purpose === 'account-detail-page') {
    if (!isAccountDetailSelectors(parsed)) {
      return jsonError(`llm returned malformed selectors: ${JSON.stringify(parsed).slice(0, 300)}`, 502);
    }
    return jsonOk({ purpose: body.purpose, selectors: parsed });
  }
  if (!isCheckModalSelectors(parsed)) {
    return jsonError(`llm returned malformed selectors: ${JSON.stringify(parsed).slice(0, 300)}`, 502);
  }
  return jsonOk({ purpose: body.purpose, selectors: parsed });
}

const SYSTEM_ACCOUNT_DETAIL = `You analyze sanitized HTML from a bank's account-detail page and return CSS selectors that identify the check transactions.

The HTML has been sanitized: text content longer than ~30 chars or containing digit runs has been replaced with placeholder Xs to remove PII. Structure (tag names, class, id, role, aria-*, data-*) is preserved. Short label text like "View Check", "Check #", or column headers is left intact so you can anchor on it.

Return ONLY this JSON shape, no prose:

{
  "rowSelector": "CSS selector matching ONE row per check transaction",
  "viewCheckButtonSelector": "CSS selector for the 'View Check' button/link inside a row",
  "checkNumberSelector": "CSS selector relative to a row that contains the check number",
  "dateSelector": "CSS selector relative to a row that contains the transaction date",
  "amountSelector": "CSS selector relative to a row that contains the amount",
  "notes": "one-sentence summary of how you identified these"
}

Rules:
- Prefer stable selectors: data-* attributes, ARIA roles, or semantic class names. Avoid nth-child unless nothing else works.
- The "relative to a row" selectors should be queryable inside the row element (no leading ' > ', no full path from <body>).
- Only include rows that are checks. If the page mixes check transactions with other transactions, the rowSelector should narrow to just checks.
- If you can't find a button labeled "View Check" or similar, set viewCheckButtonSelector to "" and explain in notes.`;

const SYSTEM_CHECK_MODAL = `You analyze sanitized HTML from a bank's "check image" modal/dialog and return CSS selectors that identify the check image elements.

The HTML has been sanitized as described — structure preserved, long text + digits replaced. Short labels like "Front", "Back", "Close" are kept.

Return ONLY this JSON shape, no prose:

{
  "modalSelector": "CSS selector for the modal/dialog container itself",
  "frontImageSelector": "CSS selector for the <img> showing the front of the check (relative to the modal)",
  "backImageToggleSelector": "CSS selector for the button/tab that switches to the back of the check, or null if the back is shown alongside the front",
  "backImageSelector": "CSS selector for the <img> showing the back of the check, or null if there's only one image",
  "closeSelector": "CSS selector for the modal's close/dismiss button, or null",
  "notes": "one-sentence summary"
}

Rules:
- Prefer role="dialog", aria-modal="true", or data-* attrs over class names containing 'modal'.
- The image selectors must resolve to <img> elements (not background-image divs).`;

function parseJsonFromText(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function isAccountDetailSelectors(v: unknown): v is AccountDetailSelectors {
  const o = v as Partial<AccountDetailSelectors>;
  return typeof o?.rowSelector === 'string'
    && typeof o?.viewCheckButtonSelector === 'string'
    && typeof o?.checkNumberSelector === 'string'
    && typeof o?.dateSelector === 'string'
    && typeof o?.amountSelector === 'string';
}

function isCheckModalSelectors(v: unknown): v is CheckModalSelectors {
  const o = v as Partial<CheckModalSelectors>;
  return typeof o?.modalSelector === 'string'
    && typeof o?.frontImageSelector === 'string';
}

// ── /check-images (POST upload) ───────────────────────────────────────────

interface CheckUploadBody {
  account_id: string;
  check_number: string | null;
  date: string | null;            // MM/DD/YYYY or YYYY-MM-DD
  amount: string | null;          // free-form, parsed below
  description: string | null;
  /** data: URL or raw base64 (image/jpeg or image/png). */
  image_front: string;
  image_back?: string | null;
}

const MAX_IMAGE_BYTES = 5_000_000;

export async function handleUploadCheckImage(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as CheckUploadBody | null;
  if (!body || !body.account_id || !body.image_front) {
    return jsonError('invalid body — needs { account_id, image_front }', 400);
  }

  const front = parseImagePayload(body.image_front);
  if (!front) return jsonError('image_front is not a valid data URL or base64 JPEG/PNG', 400);
  if (front.bytes.length > MAX_IMAGE_BYTES) return jsonError(`image_front too large (${front.bytes.length} bytes)`, 413);

  let back: ParsedImage | null = null;
  if (body.image_back) {
    back = parseImagePayload(body.image_back);
    if (!back) return jsonError('image_back is not a valid data URL or base64 JPEG/PNG', 400);
    if (back.bytes.length > MAX_IMAGE_BYTES) return jsonError(`image_back too large (${back.bytes.length} bytes)`, 413);
  }

  const checkNumber = body.check_number?.trim() || null;
  const checkDate = normalizeDate(body.date);
  const amount = parseAmount(body.amount);

  // R2 key includes check_number when present so we can locate it by hand;
  // otherwise fall back to a uuid-ish key.
  const keyBase = `checks/${body.account_id}/${checkNumber ?? `unknown-${crypto.randomUUID()}`}`;
  const frontKey = `${keyBase}-front.${front.ext}`;
  const backKey = back ? `${keyBase}-back.${back.ext}` : null;

  await env.STORAGE.put(frontKey, front.bytes, {
    httpMetadata: { contentType: front.contentType },
  });
  if (back && backKey) {
    await env.STORAGE.put(backKey, back.bytes, {
      httpMetadata: { contentType: back.contentType },
    });
  }

  // Upsert by (account_id, check_number). A re-upload replaces the row.
  // If check_number is null, every upload creates a new row.
  const sql = db(env);
  let id: string;
  try {
    if (checkNumber) {
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO check_images (
          account_id, check_number, check_date, amount, description,
          front_image_key, back_image_key, front_image_size, back_image_size,
          status
        ) VALUES (
          ${body.account_id}, ${checkNumber}, ${checkDate}, ${amount}, ${body.description ?? null},
          ${frontKey}, ${backKey}, ${front.bytes.length}, ${back?.bytes.length ?? null},
          'pending'
        )
        ON CONFLICT (account_id, check_number) DO UPDATE SET
          check_date = EXCLUDED.check_date,
          amount = EXCLUDED.amount,
          description = EXCLUDED.description,
          front_image_key = EXCLUDED.front_image_key,
          back_image_key = EXCLUDED.back_image_key,
          front_image_size = EXCLUDED.front_image_size,
          back_image_size = EXCLUDED.back_image_size,
          status = 'pending',
          extraction_error = NULL,
          updated_at = now()
        RETURNING id
      `;
      id = rows[0]!.id;
    } else {
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO check_images (
          account_id, check_date, amount, description,
          front_image_key, back_image_key, front_image_size, back_image_size,
          status
        ) VALUES (
          ${body.account_id}, ${checkDate}, ${amount}, ${body.description ?? null},
          ${frontKey}, ${backKey}, ${front.bytes.length}, ${back?.bytes.length ?? null},
          'pending'
        )
        RETURNING id
      `;
      id = rows[0]!.id;
    }
  } catch (err) {
    return jsonError(`db insert failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }

  const msg: CheckQueueMessage = { check_image_id: id };
  await env.CHECK_QUEUE.send(msg);

  return jsonOk({ id, status: 'pending' }, 201);
}

interface ParsedImage {
  bytes: Uint8Array;
  contentType: 'image/jpeg' | 'image/png';
  ext: 'jpg' | 'png';
}

function parseImagePayload(payload: string): ParsedImage | null {
  let base64 = payload;
  let contentType: 'image/jpeg' | 'image/png' = 'image/jpeg';

  const dataMatch = payload.match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
  if (dataMatch) {
    contentType = dataMatch[1] as 'image/jpeg' | 'image/png';
    base64 = dataMatch[2]!;
  }
  try {
    const binStr = atob(base64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    if (bytes.length === 0) return null;
    // Sniff if no content-type was set
    if (!dataMatch) {
      if (bytes[0] === 0x89 && bytes[1] === 0x50) contentType = 'image/png';
      else if (bytes[0] === 0xff && bytes[1] === 0xd8) contentType = 'image/jpeg';
      else return null;
    }
    return { bytes, contentType, ext: contentType === 'image/png' ? 'png' : 'jpg' };
  } catch {
    return null;
  }
}

function normalizeDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  // YYYY-MM-DD passthrough
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // MM/DD/YYYY or M/D/YY
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const mm = m[1]!.padStart(2, '0');
    const dd = m[2]!.padStart(2, '0');
    const yyyy = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function parseAmount(s: string | null | undefined): string | null {
  if (!s) return null;
  // Accepts "-1,234.56", "$1,234.56", "1234.56"
  const m = s.replace(/[$,]/g, '').match(/^-?\d+(\.\d+)?$/);
  return m ? m[0] : null;
}

// ── /check-images (GET list, GET one, GET image bytes) ─────────────────────

export async function handleListCheckImages(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const status = url.searchParams.get('status'); // 'pending'|'attached'|'match_failed'|...
  const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);

  const sql = db(env);
  try {
    const rows = status
      ? await sql<CheckImageRow[]>`
          SELECT ${sql(CHECK_IMAGE_COLUMNS)} FROM check_images
          WHERE status = ${status}
          ORDER BY created_at DESC LIMIT ${limit}
        `
      : await sql<CheckImageRow[]>`
          SELECT ${sql(CHECK_IMAGE_COLUMNS)} FROM check_images
          ORDER BY created_at DESC LIMIT ${limit}
        `;
    return jsonOk({ check_images: rows });
  } catch (err) {
    return jsonError(`list failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function handleGetCheckImage(_req: Request, env: Env, id: string): Promise<Response> {
  const sql = db(env);
  try {
    const rows = await sql<CheckImageRow[]>`
      SELECT ${sql(CHECK_IMAGE_COLUMNS)} FROM check_images WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return jsonError('not found', 404);
    return jsonOk({ check_image: rows[0] });
  } catch (err) {
    return jsonError(`get failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Stream the front- or back-image bytes from R2. Used by SPA <img src=...>.
 * Side is "front" | "back".
 */
export async function handleGetCheckImageContent(_req: Request, env: Env, id: string, side: string): Promise<Response> {
  if (side !== 'front' && side !== 'back') return jsonError('side must be front|back', 400);
  const sql = db(env);
  let key: string | null;
  try {
    const rows = await sql<Array<{ front_image_key: string | null; back_image_key: string | null }>>`
      SELECT front_image_key, back_image_key FROM check_images WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return jsonError('not found', 404);
    key = side === 'front' ? rows[0]!.front_image_key : rows[0]!.back_image_key;
  } catch (err) {
    return jsonError(`lookup failed: ${String(err)}`, 500);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  if (!key) return jsonError('no image for this side', 404);

  const obj = await env.STORAGE.get(key);
  if (!obj) return jsonError('object missing in storage', 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}

// ── DB row shape ───────────────────────────────────────────────────────────

const CHECK_IMAGE_COLUMNS = [
  'id', 'account_id', 'check_number', 'check_date', 'amount', 'description',
  'front_image_key', 'back_image_key',
  'extracted_payee', 'extracted_amount', 'extracted_date', 'extracted_memo',
  'extraction_confidence', 'extraction_error',
  'status', 'matched_transaction_id', 'matched_raw_id', 'match_method',
  'created_at', 'updated_at',
];

interface CheckImageRow {
  id: string;
  account_id: string;
  check_number: string | null;
  check_date: string | null;
  amount: string | null;
  description: string | null;
  front_image_key: string;
  back_image_key: string | null;
  extracted_payee: string | null;
  extracted_amount: string | null;
  extracted_date: string | null;
  extracted_memo: string | null;
  extraction_confidence: string | null;
  extraction_error: string | null;
  status: string;
  matched_transaction_id: string | null;
  matched_raw_id: string | null;
  match_method: string | null;
  created_at: string;
  updated_at: string;
}
