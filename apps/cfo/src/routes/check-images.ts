/**
 * POST /check-images
 *
 * Receives a captured Wells Fargo check image from the browser extension,
 * stores it in R2, runs Claude Vision to extract the payee, and optionally
 * updates the matching transaction's note field.
 *
 * Auth: if env.EXTERNAL_API_KEY is set, requires "Authorization: Bearer <key>".
 * CORS: the worker's global CORS handler adds Access-Control-Allow-Origin: *.
 */

import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';

interface CheckImagePayload {
  check_number?: string | null;
  date?: string | null;
  amount?: string | null;
  description?: string | null;
  account_id?: string | null;
  image_front?: string | null;  // base64 data URL
  image_back?: string | null;   // base64 data URL (optional)
}

export async function handleUploadCheckImage(request: Request, env: Env): Promise<Response> {
  // Auth
  const apiKey = env.EXTERNAL_API_KEY;
  if (apiKey) {
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== apiKey) {
      return jsonError('Unauthorized', 401);
    }
  }

  let payload: CheckImagePayload;
  try {
    payload = await request.json() as CheckImagePayload;
  } catch {
    return jsonError('Invalid JSON body');
  }

  if (!payload.image_front) {
    return jsonError('image_front is required');
  }

  // Parse base64 data URL(s)
  const frontParsed = parseDataUrl(payload.image_front);
  if (!frontParsed) return jsonError('image_front must be a base64 data URL (data:image/...;base64,...)');

  const backParsed = payload.image_back ? parseDataUrl(payload.image_back) : null;

  // Build R2 key
  const accountSlug = (payload.account_id ?? 'unknown').replace(/[^a-zA-Z0-9-]/g, '_');
  const checkSlug = (payload.check_number ?? 'unknown').replace(/[^a-zA-Z0-9-]/g, '_');
  const dateSlug = (payload.date ?? new Date().toISOString().slice(0, 10)).replace(/\//g, '-');
  const keyBase = `check-images/${accountSlug}/${dateSlug}-check${checkSlug}`;

  // Store front image in R2
  await env.BUCKET.put(`${keyBase}-front.jpg`, frontParsed.bytes, {
    httpMetadata: { contentType: frontParsed.mimeType },
    customMetadata: {
      check_number: payload.check_number ?? '',
      date: payload.date ?? '',
      amount: payload.amount ?? '',
      account_id: payload.account_id ?? '',
    },
  });

  // Store back image if present
  if (backParsed) {
    await env.BUCKET.put(`${keyBase}-back.jpg`, backParsed.bytes, {
      httpMetadata: { contentType: backParsed.mimeType },
    });
  }

  // Run Claude Vision OCR on the front image to extract the payee
  const payee = await extractPayee(env, payload.image_front);

  // Best-effort: find the matching transaction and annotate it
  let updatedTransactionId: string | null = null;
  if (payee && payload.check_number) {
    updatedTransactionId = await annotateTransaction(env, payload, payee);
  }

  return jsonOk({
    r2_key: `${keyBase}-front.jpg`,
    payee,
    updated_transaction_id: updatedTransactionId,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Uint8Array } | null {
  const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
  if (!match) return null;
  const mimeType = match[1];
  try {
    const binaryStr = atob(match[2]);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return { mimeType, bytes };
  } catch {
    return null;
  }
}

async function extractPayee(env: Env, imageDataUrl: string): Promise<string | null> {
  try {
    const mediaTypeMatch = imageDataUrl.match(/^data:(image\/[a-z]+);base64,/i);
    const mediaType = (mediaTypeMatch?.[1] ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    const base64Data = imageDataUrl.split(',')[1];
    if (!base64Data) return null;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            {
              type: 'text',
              text: 'This is a scanned check. Extract the "Pay to the order of" field (the payee name). Reply with only the payee name — nothing else. If you cannot read it, reply "unknown".',
            },
          ],
        }],
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content?.[0]?.text?.trim();
    return text === 'unknown' || !text ? null : text;
  } catch {
    return null;
  }
}

async function annotateTransaction(env: Env, payload: CheckImagePayload, payee: string): Promise<string | null> {
  try {
    // Look up internal account ID by teller_account_id (WF's internal account ID)
    let accountCondition = '';
    const queryVals: unknown[] = [];

    if (payload.account_id) {
      const acct = await env.DB
        .prepare('SELECT id FROM accounts WHERE teller_account_id = ? LIMIT 1')
        .bind(payload.account_id)
        .first<{ id: string }>();
      if (acct?.id) {
        accountCondition = 'AND t.account_id = ?';
        queryVals.push(acct.id);
      }
    }

    // Match by check number in description (e.g. "CHECK 352" or "CHECK # 352")
    const pattern = `%${payload.check_number}%`;
    const row = await env.DB
      .prepare(
        `SELECT t.id FROM transactions t
         WHERE (UPPER(t.description) LIKE '%CHECK%' OR UPPER(t.merchant_name) LIKE '%CHECK%')
           AND (t.description LIKE ? OR t.merchant_name LIKE ?)
           ${accountCondition}
         ORDER BY t.posted_date DESC
         LIMIT 1`,
      )
      .bind(pattern, pattern, ...queryVals)
      .first<{ id: string }>();

    if (!row?.id) return null;

    await env.DB
      .prepare("UPDATE transactions SET note = ? WHERE id = ?")
      .bind(`Payee: ${payee}`, row.id)
      .run();

    return row.id;
  } catch {
    return null;
  }
}
