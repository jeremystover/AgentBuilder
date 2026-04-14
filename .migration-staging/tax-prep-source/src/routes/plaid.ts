import { z } from 'zod';
import type { Env } from '../types';
import { jsonOk, jsonError, getUserId } from '../types';
import {
  createLinkToken,
  exchangePublicToken,
  getItem,
  getAccounts,
  getInstitution,
  syncTransactions,
  sandboxCreatePublicToken,
} from '../lib/plaid';
import { computeDedupHash, cleanDescription } from '../lib/dedup';
import { ensureUnclassifiedReviewQueue } from '../lib/review-queue';

interface PlaidSyncSummary {
  transactions_imported: number;
  duplicates_skipped: number;
  by_institution: Array<{ institution: string | null; added: number; dupes: number }>;
  account_ids_synced: string[];
  message: string;
}

export async function createPlaidLinkTokenForUser(
  env: Env,
  userId: string,
): Promise<{ link_token: string; expiration: string }> {
  return createLinkToken(env, userId);
}

export async function exchangePlaidPublicTokenForUser(
  env: Env,
  userId: string,
  publicToken: string,
): Promise<{ item_id: string; institution: string | null; accounts_linked: number; message: string }> {
  const { access_token, item_id } = await exchangePublicToken(env, publicToken);

  const { item } = await getItem(env, access_token);
  let institutionName: string | null = null;
  if (item.institution_id) {
    try {
      const inst = await getInstitution(env, item.institution_id);
      institutionName = inst.institution.name;
    } catch {
      // Institution metadata is helpful but non-blocking.
    }
  }

  const plaidItemId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO plaid_items (id, user_id, item_id, access_token, institution_id, institution_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       access_token=excluded.access_token,
       institution_id=excluded.institution_id,
       institution_name=excluded.institution_name`,
  ).bind(plaidItemId, userId, item_id, access_token, item.institution_id ?? null, institutionName).run();

  const plaidItem = await env.DB.prepare(
    'SELECT id FROM plaid_items WHERE item_id = ?',
  ).bind(item_id).first<{ id: string }>();
  if (!plaidItem) throw new Error('Failed to save Plaid item');

  const { accounts } = await getAccounts(env, access_token);
  for (const acct of accounts) {
    const accountId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO accounts (id, plaid_item_id, user_id, plaid_account_id, name, mask, type, subtype)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plaid_account_id) DO UPDATE SET
         plaid_item_id=excluded.plaid_item_id,
         name=excluded.name,
         mask=excluded.mask,
         type=excluded.type,
         subtype=excluded.subtype,
         is_active=1`,
    ).bind(
      accountId,
      plaidItem.id,
      userId,
      acct.account_id,
      acct.name,
      acct.mask ?? null,
      acct.type,
      acct.subtype ?? null,
    ).run();
  }

  return {
    item_id,
    institution: institutionName,
    accounts_linked: accounts.length,
    message: 'Accounts connected. Call POST /bank/sync to import transactions.',
  };
}

export async function syncPlaidTransactionsForUser(
  env: Env,
  userId: string,
  dateFrom: string | null,
  dateTo: string | null,
): Promise<PlaidSyncSummary> {
  const items = await env.DB.prepare(
    'SELECT * FROM plaid_items WHERE user_id = ?',
  ).bind(userId).all<{ id: string; access_token: string; cursor: string | null; institution_name: string | null }>();

  if (!items.results.length) {
    throw new Error('No linked Plaid accounts found. Connect an account first.');
  }

  let totalAdded = 0;
  let totalDupes = 0;
  const syncedAccountIds = new Set<string>();
  const importResults: Array<{ institution: string | null; added: number; dupes: number }> = [];

  for (const plaidItem of items.results) {
    const importId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO imports (id, user_id, source, status, date_from, date_to, tax_year)
       VALUES (?, ?, 'plaid', 'running', ?, ?, ?)`,
    ).bind(importId, userId, dateFrom, dateTo, dateFrom ? parseInt(dateFrom.slice(0, 4), 10) : null).run();

    let cursor = plaidItem.cursor;
    let hasMore = true;
    let added = 0;
    let dupes = 0;

    try {
      while (hasMore) {
        const sync = await syncTransactions(env, plaidItem.access_token, cursor);

        for (const tx of sync.added) {
          const account = await env.DB.prepare(
            'SELECT id FROM accounts WHERE plaid_account_id = ?',
          ).bind(tx.account_id).first<{ id: string }>();

          const accountId = account?.id ?? null;
          if (accountId) syncedAccountIds.add(accountId);
          const description = tx.name;
          const descriptionClean = cleanDescription(description);
          const dedupHash = await computeDedupHash(
            tx.account_id,
            tx.date,
            tx.amount,
            description,
          );

          const txId = crypto.randomUUID();
          const result = await env.DB.prepare(
            `INSERT OR IGNORE INTO transactions
               (id, user_id, account_id, import_id, plaid_transaction_id,
                posted_date, amount, currency, merchant_name, description,
                description_clean, category_plaid, is_pending, dedup_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            txId,
            userId,
            accountId,
            importId,
            tx.transaction_id,
            tx.date,
            tx.amount,
            tx.iso_currency_code ?? 'USD',
            tx.merchant_name ?? null,
            description,
            descriptionClean,
            tx.category ? tx.category[0] : null,
            tx.pending ? 1 : 0,
            dedupHash,
          ).run();

          if (result.meta.changes > 0) {
            added++;
            await ensureUnclassifiedReviewQueue(env, txId, userId);
          } else dupes++;
        }

        for (const tx of sync.modified) {
          const existing = await env.DB.prepare(
            'SELECT id FROM transactions WHERE plaid_transaction_id = ?',
          ).bind(tx.transaction_id).first<{ id: string }>();

          await env.DB.prepare(
            `UPDATE transactions
             SET amount=?, merchant_name=?, description=?, is_pending=?
             WHERE plaid_transaction_id=?`,
          ).bind(tx.amount, tx.merchant_name ?? null, tx.name, tx.pending ? 1 : 0, tx.transaction_id).run();

          if (existing) {
            await ensureUnclassifiedReviewQueue(env, existing.id, userId);
          }
        }

        for (const removed of sync.removed) {
          await env.DB.prepare(
            'DELETE FROM transactions WHERE plaid_transaction_id = ?',
          ).bind(removed.transaction_id).run();
        }

        cursor = sync.next_cursor;
        hasMore = sync.has_more;
      }

      await env.DB.prepare(
        `UPDATE plaid_items SET cursor=?, last_synced_at=datetime('now') WHERE id=?`,
      ).bind(cursor, plaidItem.id).run();

      await env.DB.prepare(
        `UPDATE imports
         SET status='completed', transactions_found=?, transactions_imported=?, completed_at=datetime('now')
         WHERE id=?`,
      ).bind(added + dupes, added, importId).run();
    } catch (err) {
      await env.DB.prepare(
        `UPDATE imports SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`,
      ).bind(String(err), importId).run();
    }

    totalAdded += added;
    totalDupes += dupes;
    importResults.push({ institution: plaidItem.institution_name, added, dupes });
  }

  return {
    transactions_imported: totalAdded,
    duplicates_skipped: totalDupes,
    by_institution: importResults,
    account_ids_synced: [...syncedAccountIds],
    message: 'Sync complete. New transactions are queued for review.',
  };
}

// ── POST /plaid/link-token ────────────────────────────────────────────────────
export async function handleCreateLinkToken(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);
  try {
    const result = await createPlaidLinkTokenForUser(env, userId);
    return jsonOk(result);
  } catch (err) {
    return jsonError(String(err), 502);
  }
}

// ── POST /plaid/sandbox/public-token ─────────────────────────────────────────
// Sandbox shortcut: skips the Link UI and returns a public_token you can pass
// directly to POST /plaid/exchange-token. Only works when PLAID_ENV=sandbox.
// Optional body: { institution_id: "ins_109508" }
// Common sandbox institution IDs:
//   ins_109508 = Chase, ins_109510 = Bank of America, ins_109511 = Wells Fargo
//   ins_115616 = American Express, ins_109512 = Citi
export async function handleSandboxPublicToken(request: Request, env: Env): Promise<Response> {
  let institutionId: string | undefined;
  try {
    const body = await request.json() as { institution_id?: string };
    institutionId = body.institution_id;
  } catch {
    // Optional body.
  }

  try {
    const result = await sandboxCreatePublicToken(env, institutionId);
    return jsonOk({
      ...result,
      next_step: `POST /plaid/exchange-token with body: {"public_token": "${result.public_token}"}`,
    });
  } catch (err) {
    return jsonError(String(err), env.PLAID_ENV !== 'sandbox' ? 403 : 502);
  }
}

// ── POST /plaid/exchange-token ────────────────────────────────────────────────
const ExchangeSchema = z.object({ public_token: z.string().min(1) });

export async function handleExchangeToken(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON');
  }

  const parsed = ExchangeSchema.safeParse(body);
  if (!parsed.success) return jsonError(parsed.error.message);

  try {
    const result = await exchangePlaidPublicTokenForUser(env, userId, parsed.data.public_token);
    return jsonOk(result, 201);
  } catch (err) {
    return jsonError(String(err), 502);
  }
}

// ── POST /plaid/sync ──────────────────────────────────────────────────────────
// Syncs all connected Plaid items for the user. Accepts optional { date_from, date_to } but
// Plaid's /transactions/sync is cursor-based, so those are only for documentation/import job metadata.
export async function handleSync(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  try {
    const body = await request.json() as { date_from?: string; date_to?: string };
    dateFrom = body.date_from ?? null;
    dateTo = body.date_to ?? null;
  } catch {
    // Body is optional.
  }

  try {
    const result = await syncPlaidTransactionsForUser(env, userId, dateFrom, dateTo);
    return jsonOk(result);
  } catch (err) {
    return jsonError(String(err), 502);
  }
}
