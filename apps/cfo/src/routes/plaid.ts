import type { Env } from '../types';
import { cleanDescription, computeDedupHash } from '../lib/dedup';
import {
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  syncTransactions,
  getPlaidInstitutionByKey,
  PLAID_INSTITUTIONS,
  type PlaidTransaction,
} from '../lib/plaid';

export interface PlaidConnectPayload {
  public_token: string;
  institution_key: string; // our internal key (e.g. 'patelco')
  institution_name: string | null; // display name from Plaid Link metadata
  plaid_institution_id: string | null; // Plaid ins_* id from Plaid Link metadata
}

interface PlaidSyncSummary {
  transactions_imported: number;
  duplicates_skipped: number;
  by_institution: Array<{ institution: string | null; added: number; dupes: number }>;
  account_ids_synced: string[];
  message: string;
}

// ── Config & connect ──────────────────────────────────────────────────────────

export function getPlaidBankConfig(env: Env, institutionId?: string): {
  provider: 'plaid';
  institutions: typeof PLAID_INSTITUTIONS;
  institution_id?: string;
} {
  return {
    provider: 'plaid',
    institutions: PLAID_INSTITUTIONS,
    ...(institutionId ? { institution_id: institutionId } : {}),
  };
}

export async function startPlaidConnect(
  env: Env,
  userId: string,
  institutionKey?: string,
): Promise<{ provider: 'plaid'; link_token: string; expiration: string; institutions: typeof PLAID_INSTITUTIONS }> {
  // Resolve the Plaid ins_* ID if available to pre-select the institution in
  // Plaid Link (skips the search step). Falls back to open picker when null.
  const inst = institutionKey ? getPlaidInstitutionByKey(institutionKey) : undefined;
  const { link_token, expiration } = await createLinkToken(env, userId, inst?.plaid_id ?? null);
  return {
    provider: 'plaid',
    link_token,
    expiration,
    institutions: PLAID_INSTITUTIONS,
  };
}

export async function connectPlaidItemForUser(
  env: Env,
  userId: string,
  payload: PlaidConnectPayload,
): Promise<{ item_id: string; institution: string | null; accounts_linked: number; message: string }> {
  const { access_token, item_id } = await exchangePublicToken(env, payload.public_token);
  const plaidAccounts = await getAccounts(env, access_token);

  const institutionName = payload.institution_name
    ?? getPlaidInstitutionByKey(payload.institution_key)?.name
    ?? null;

  const plaidItemId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO plaid_items (id, user_id, item_id, access_token, institution_id, institution_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       access_token = excluded.access_token,
       institution_id = COALESCE(excluded.institution_id, plaid_items.institution_id),
       institution_name = COALESCE(excluded.institution_name, plaid_items.institution_name)`,
  ).bind(plaidItemId, userId, item_id, access_token, payload.plaid_institution_id, institutionName).run();

  const savedItem = await env.DB.prepare(
    'SELECT id FROM plaid_items WHERE item_id = ?',
  ).bind(item_id).first<{ id: string }>();
  if (!savedItem) throw new Error('Failed to save Plaid item');

  let accountsLinked = 0;
  for (const acct of plaidAccounts) {
    const existing = await env.DB.prepare(
      'SELECT id FROM accounts WHERE plaid_account_id = ?',
    ).bind(acct.account_id).first<{ id: string }>();

    if (existing) {
      await env.DB.prepare(
        `UPDATE accounts SET plaid_item_id=?, name=?, mask=?, type=?, subtype=?, is_active=1
         WHERE plaid_account_id=?`,
      ).bind(savedItem.id, acct.name, acct.mask, acct.type, acct.subtype, acct.account_id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO accounts (id, plaid_item_id, user_id, plaid_account_id, name, mask, type, subtype)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        savedItem.id,
        userId,
        acct.account_id,
        acct.name,
        acct.mask,
        acct.type,
        acct.subtype,
      ).run();
    }
    accountsLinked++;
  }

  return {
    item_id,
    institution: institutionName,
    accounts_linked: accountsLinked,
    message: 'Accounts connected. Call POST /bank/sync to import transactions.',
  };
}

// ── Transaction sync ──────────────────────────────────────────────────────────

async function syncPlaidItemTransactions(
  env: Env,
  userId: string,
  itemDbId: string,
  accessToken: string,
  cursor: string | null,
  importId: string,
  accountIds?: Set<string>,
): Promise<{ added: number; dupes: number; next_cursor: string }> {
  const allAdded: PlaidTransaction[] = [];
  const allModified: PlaidTransaction[] = [];
  const allRemoved: string[] = [];
  let next_cursor = cursor ?? '';

  // Drain all pages
  let hasMore = true;
  while (hasMore) {
    const page = await syncTransactions(env, accessToken, next_cursor || undefined);
    allAdded.push(...page.added);
    allModified.push(...page.modified);
    allRemoved.push(...page.removed.map(r => r.transaction_id));
    next_cursor = page.next_cursor;
    hasMore = page.has_more;
  }

  // Resolve DB account IDs for any Plaid account_id we encounter
  const plaidToDbAccountId = new Map<string, string>();
  {
    const accts = await env.DB.prepare(
      `SELECT id, plaid_account_id FROM accounts
       WHERE user_id = ? AND plaid_item_id = ? AND is_active = 1 AND plaid_account_id IS NOT NULL`,
    ).bind(userId, itemDbId).all<{ id: string; plaid_account_id: string }>();
    for (const a of accts.results) plaidToDbAccountId.set(a.plaid_account_id, a.id);
  }

  let added = 0;
  let dupes = 0;

  const BATCH = 100;
  const insertStatements: D1PreparedStatement[] = [];
  const insertMeta: Array<{ txId: string }> = [];
  const updateStatements: D1PreparedStatement[] = [];
  const deleteStatements: D1PreparedStatement[] = [];

  // Process adds
  for (const tx of allAdded) {
    const dbAccountId = plaidToDbAccountId.get(tx.account_id);
    if (!dbAccountId) continue;
    if (accountIds && !accountIds.has(dbAccountId)) continue;

    // Plaid: positive = debit (expense), negative = credit (income). Negate to match DB convention.
    const amount = -tx.amount;
    const date = tx.authorized_date ?? tx.date;
    const descClean = cleanDescription(tx.name);
    const dedupHash = await computeDedupHash(dbAccountId, date, amount, tx.name);

    const txId = crypto.randomUUID();
    insertStatements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO transactions
         (id, user_id, account_id, import_id, plaid_transaction_id,
          posted_date, amount, currency, merchant_name, description,
          description_clean, category_plaid, is_pending, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      txId, userId, dbAccountId, importId, tx.transaction_id,
      date, amount, tx.merchant_name, tx.name, descClean,
      tx.personal_finance_category?.primary ?? null,
      tx.pending ? 1 : 0, dedupHash,
    ));
    insertMeta.push({ txId });
  }

  // Process modifications
  for (const tx of allModified) {
    const dbAccountId = plaidToDbAccountId.get(tx.account_id);
    if (!dbAccountId) continue;
    if (accountIds && !accountIds.has(dbAccountId)) continue;

    const amount = -tx.amount;
    const date = tx.authorized_date ?? tx.date;
    const descClean = cleanDescription(tx.name);
    const dedupHash = await computeDedupHash(dbAccountId, date, amount, tx.name);

    updateStatements.push(env.DB.prepare(
      `UPDATE transactions
       SET posted_date=?, amount=?, merchant_name=?, description=?, description_clean=?,
           category_plaid=?, is_pending=?, dedup_hash=?
       WHERE plaid_transaction_id=? AND account_id=?`,
    ).bind(
      date, amount, tx.merchant_name, tx.name, descClean,
      tx.personal_finance_category?.primary ?? null,
      tx.pending ? 1 : 0, dedupHash,
      tx.transaction_id, dbAccountId,
    ));
  }

  // Process removals (Plaid can remove pending transactions that were cancelled)
  for (const plaidTxId of allRemoved) {
    deleteStatements.push(env.DB.prepare(
      `DELETE FROM transactions WHERE plaid_transaction_id = ? AND is_pending = 1`,
    ).bind(plaidTxId));
  }

  // Batch updates
  for (let i = 0; i < updateStatements.length; i += BATCH) {
    await env.DB.batch(updateStatements.slice(i, i + BATCH));
  }

  // Batch deletes
  for (let i = 0; i < deleteStatements.length; i += BATCH) {
    await env.DB.batch(deleteStatements.slice(i, i + BATCH));
  }

  // Batch inserts, build review queue for landed rows
  const reviewStatements: D1PreparedStatement[] = [];
  for (let i = 0; i < insertStatements.length; i += BATCH) {
    const results = await env.DB.batch(insertStatements.slice(i, i + BATCH));
    for (let j = 0; j < results.length; j++) {
      const meta = insertMeta[i + j];
      if (results[j].meta.changes > 0) {
        added++;
        reviewStatements.push(env.DB.prepare(
          `INSERT OR IGNORE INTO review_queue
             (id, transaction_id, user_id, reason, confidence, details, needs_input)
           VALUES (?, ?, ?, 'unclassified', NULL,
             'No rule match or saved classification exists for this transaction yet.',
             'A clearer merchant name, notes, or a manual classification for a similar transaction would help future matches.')`,
        ).bind(crypto.randomUUID(), meta.txId, userId));
      } else {
        dupes++;
      }
    }
  }

  for (let i = 0; i < reviewStatements.length; i += BATCH) {
    await env.DB.batch(reviewStatements.slice(i, i + BATCH));
  }

  return { added, dupes, next_cursor };
}

export async function syncPlaidTransactionsForUser(
  env: Env,
  userId: string,
  accountIds?: string[],
): Promise<PlaidSyncSummary> {
  const items = await env.DB.prepare(
    `SELECT id, item_id, access_token, institution_name, cursor
     FROM plaid_items
     WHERE user_id = ?`,
  ).bind(userId).all<{ id: string; item_id: string; access_token: string; institution_name: string | null; cursor: string | null }>();

  if (!items.results.length) {
    throw new Error('No linked Plaid accounts found. Connect an account first.');
  }

  const requestedAccountIds = accountIds?.length ? new Set(accountIds) : undefined;
  let totalAdded = 0;
  let totalDupes = 0;
  const syncedAccountIds = new Set<string>();
  const byInstitution: Array<{ institution: string | null; added: number; dupes: number }> = [];

  for (const item of items.results) {
    const importId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO imports (id, user_id, source, status) VALUES (?, ?, 'plaid', 'running')`,
    ).bind(importId, userId).run();

    let added = 0;
    let dupes = 0;

    try {
      const { added: a, dupes: d, next_cursor } = await syncPlaidItemTransactions(
        env, userId, item.id, item.access_token, item.cursor, importId, requestedAccountIds,
      );
      added = a;
      dupes = d;

      // Persist the new cursor so next sync is incremental
      await env.DB.prepare(
        `UPDATE plaid_items SET cursor=?, last_synced_at=datetime('now') WHERE id=?`,
      ).bind(next_cursor, item.id).run();

      await env.DB.prepare(
        `UPDATE imports SET status='completed', transactions_imported=?, completed_at=datetime('now') WHERE id=?`,
      ).bind(added, importId).run();
    } catch (err) {
      await env.DB.prepare(
        `UPDATE imports SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`,
      ).bind(String(err), importId).run();
      throw err;
    }

    totalAdded += added;
    totalDupes += dupes;
    byInstitution.push({ institution: item.institution_name, added, dupes });
  }

  return {
    transactions_imported: totalAdded,
    duplicates_skipped: totalDupes,
    by_institution: byInstitution,
    account_ids_synced: [...syncedAccountIds],
    message: 'Sync complete. New transactions are queued for review.',
  };
}
