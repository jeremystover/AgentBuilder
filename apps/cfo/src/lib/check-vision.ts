/**
 * Process a single check image: read it from R2, run Claude vision to
 * extract { payee, amount, date, memo }, then try to attach it to a
 * matching transaction by (account_id, check_number). Writes results
 * back to `check_images`.
 *
 * Called by the queue consumer in src/index.ts. Never throws to the
 * consumer — failures land in `check_images.extraction_error` with
 * status = 'error'.
 */

import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../types';
import { db } from './db';

export interface CheckQueueMessage {
  check_image_id: string;
}

const VISION_SYSTEM = `You read a personal check image and return ONLY this JSON shape, no prose:

{
  "payee": "name of the person or business written on the 'Pay to the order of' line, or null if unreadable",
  "amount": "dollar amount as a string like '1234.56', or null if unreadable",
  "date": "YYYY-MM-DD date written on the check, or null",
  "memo": "memo line text, or null",
  "confidence": 0.0-1.0
}

Rules:
- Use only what is visible on the check itself. Do not infer from context.
- Payee should be cleaned up: trim trailing spaces, normalize spacing, but keep the name as written.
- Confidence reflects your overall certainty. <0.5 means the image is hard to read.`;

interface VisionResult {
  payee: string | null;
  amount: string | null;
  date: string | null;
  memo: string | null;
  confidence: number;
}

export async function processCheckImage(env: Env, message: CheckQueueMessage): Promise<void> {
  const id = message.check_image_id;
  const sql = db(env);

  try {
    // Mark processing + load row
    const rows = await sql<Array<{
      id: string; account_id: string; check_number: string | null;
      front_image_key: string; back_image_key: string | null;
      check_date: string | null; amount: string | null;
    }>>`
      UPDATE check_images SET status = 'processing', updated_at = now()
      WHERE id = ${id} AND status IN ('pending', 'error')
      RETURNING id, account_id, check_number, front_image_key, back_image_key, check_date, amount
    `;
    if (rows.length === 0) {
      // Someone else picked it up, or it's already done. Bail.
      return;
    }
    const row = rows[0]!;

    // Load front image bytes
    const obj = await env.STORAGE.get(row.front_image_key);
    if (!obj) {
      await sql`
        UPDATE check_images SET status = 'error', extraction_error = ${`front image missing in R2: ${row.front_image_key}`}, updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }
    const contentType = obj.httpMetadata?.contentType ?? 'image/jpeg';
    const mediaType: 'image/jpeg' | 'image/png' = contentType === 'image/png' ? 'image/png' : 'image/jpeg';
    const buf = await obj.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);

    // Vision call
    let vision: VisionResult | null = null;
    let visionRaw = '';
    try {
      const llm = new LLMClient({ anthropicApiKey: env.ANTHROPIC_API_KEY });
      const resp = await llm.complete({
        tier: 'default',
        system: VISION_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', mediaType, data: base64 },
            { type: 'text', text: 'Extract the check details. Return only the JSON object specified.' },
          ],
        }],
        maxOutputTokens: 400,
      });
      visionRaw = resp.text;
      vision = parseVision(resp.text);
    } catch (err) {
      await sql`
        UPDATE check_images SET status = 'error', extraction_error = ${`vision call failed: ${String(err)}`}, updated_at = now()
        WHERE id = ${id}
      `;
      return;
    }

    if (!vision) {
      const errMsg = `could not parse vision response: ${visionRaw.slice(0, 300)}`;
      await sql`
        UPDATE check_images SET
          status = 'error',
          extraction_error = ${errMsg},
          extraction_raw_json = ${visionRaw}::jsonb,
          updated_at = now()
        WHERE id = ${id}
      `.catch(async () => {
        await sql`
          UPDATE check_images SET status = 'error', extraction_error = ${errMsg}, updated_at = now()
          WHERE id = ${id}
        `;
      });
      return;
    }

    // Persist extraction
    await sql`
      UPDATE check_images SET
        extracted_payee = ${vision.payee},
        extracted_amount = ${vision.amount},
        extracted_date = ${vision.date},
        extracted_memo = ${vision.memo},
        extraction_confidence = ${vision.confidence},
        extraction_raw_json = ${JSON.stringify(vision)}::jsonb,
        extraction_error = NULL,
        status = 'analyzed',
        updated_at = now()
      WHERE id = ${id}
    `;

    // Try to match to an existing transaction (approved) or raw_transaction (in review).
    // Match by (account_id, check_number) — both sources stuff CHECK #N into description.
    if (row.check_number) {
      const checkPattern = `%CHECK%${row.check_number}%`;

      const txMatches = await sql<Array<{ id: string }>>`
        SELECT id FROM transactions
        WHERE account_id = ${row.account_id}
          AND description ILIKE ${checkPattern}
        ORDER BY date DESC
        LIMIT 1
      `;

      if (txMatches.length > 0) {
        const txId = txMatches[0]!.id;
        await sql`
          UPDATE check_images SET
            status = 'attached',
            matched_transaction_id = ${txId},
            match_method = 'check_number_account',
            updated_at = now()
          WHERE id = ${id}
        `;
        // If the transaction has no merchant, fill it in from the check.
        if (vision.payee) {
          await sql`
            UPDATE transactions SET merchant = ${vision.payee}, updated_at = now()
            WHERE id = ${txId} AND (merchant IS NULL OR merchant = '')
          `;
        }
        return;
      }

      const rawMatches = await sql<Array<{ id: string }>>`
        SELECT id FROM raw_transactions
        WHERE account_id = ${row.account_id}
          AND description ILIKE ${checkPattern}
        ORDER BY date DESC
        LIMIT 1
      `;

      if (rawMatches.length > 0) {
        const rawId = rawMatches[0]!.id;
        await sql`
          UPDATE check_images SET
            status = 'attached',
            matched_raw_id = ${rawId},
            match_method = 'check_number_account',
            updated_at = now()
          WHERE id = ${id}
        `;
        if (vision.payee) {
          await sql`
            UPDATE raw_transactions SET merchant = ${vision.payee}
            WHERE id = ${rawId} AND (merchant IS NULL OR merchant = '')
          `;
        }
        return;
      }
    }

    // No match
    await sql`
      UPDATE check_images SET status = 'match_failed', updated_at = now()
      WHERE id = ${id}
    `;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

function parseVision(text: string): VisionResult | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<VisionResult>;
    return {
      payee: typeof parsed.payee === 'string' ? parsed.payee.trim() : null,
      amount: typeof parsed.amount === 'string' ? parsed.amount : null,
      date: typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null,
      memo: typeof parsed.memo === 'string' ? parsed.memo : null,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    };
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binStr = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binStr += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binStr);
}
