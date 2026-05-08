import type { Env } from '../types';
import { cleanDescription, computeDedupHash } from '../lib/dedup';
import {
  getTellerConnectConfig,
  listAccounts,
  listTransactions,
  type TellerEnrollmentPayload,
  type TellerTransaction,
} from '../lib/teller';

interface TellerSyncSummary {
  transactions_imported: number;
  duplicates_skipped: number;
  by_institution: Array<{ institution: string | null; added: number; dupes: number }>;
  account_ids_synced: string[];
  message: string;
}


function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDate(base: string, days: number): string {
  const date = new Date(`${base}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function todayIsoDate(): string {
  return isoDate(new Date());
}

async function syncAccountTransactions(
  env: Env,
  userId: string,
  accountId: string,
  providerAccountId: string,
  importId: string,
  transactions: TellerTransaction[],
): Promise<{ added: number; dupes: number }> {
  if (transactions.length === 0) return { added: 0, dupes: 0 };

  // Pre-fetch all existing teller tx IDs for this account (1 query instead of N)
  const existingRows = await env.DB.prepare(
    `SELECT id, teller_transaction_id FROM transactions
     WHERE account_id = ? AND teller_transaction_id IS NOT NULL`,
  ).bind(accountId).all<{ id: string; teller_transaction_id: string }>();
  const existingMap = new Map(existingRows.results.map(r => [r.teller_transaction_id, r.id]));

  // Pre-fetch all pending transactions for this account (1 query instead of N)
  const pendingRows = await env.DB.prepare(
    `SELECT id, amount, description_clean, posted_date FROM transactions
     WHERE account_id = ? AND is_pending = 1 AND teller_transaction_id IS NOT NULL`,
  ).bind(accountId).all<{ id: string; amount: number; description_clean: string; posted_date: string }>();
  const pendingList = [...pendingRows.results];

  // Compute all dedup hashes in parallel
  const amounts = transactions.map(tx => {
    const n = Number(tx.amount);
    if (Number.isNaN(n)) throw new Error(`Bad amount "${tx.amount}" for ${tx.id}`);
    return n;
  });
  const hashes = await Promise.all(
    transactions.map((tx, i) => computeDedupHash(providerAccountId, tx.date, amounts[i], tx.description)),
  );

  const BATCH = 100;
  const updateStatements: D1PreparedStatement[] = [];
  const insertStatements: D1PreparedStatement[] = [];
  const insertMeta: Array<{ txId: string; isPosted: boolean }> = [];

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const amount = amounts[i];
    const dedupHash = hashes[i];
    const descClean = cleanDescription(tx.description);
    const merchant = tx.details?.counterparty?.name ?? null;
    const category = tx.details?.category ?? null;
    const isPending = tx.status === 'pending' ? 1 : 0;

    const existingId = existingMap.get(tx.id);
    if (existingId) {
      updateStatements.push(env.DB.prepare(
        `UPDATE transactions
         SET account_id=?, import_id=?, posted_date=?, amount=?, currency='USD',
             merchant_name=?, description=?, description_clean=?, category_plaid=?,
             is_pending=?, dedup_hash=?
         WHERE id=?`,
      ).bind(accountId, importId, tx.date, amount, merchant, tx.description, descClean, category, isPending, dedupHash, existingId));
      continue;
    }

    // Pending → posted promotion (match in-memory)
    if (tx.status === 'posted') {
      const lo = shiftIsoDate(tx.date, -10);
      const hi = shiftIsoDate(tx.date, 10);
      const matchIdx = pendingList.findIndex(
        p => p.amount === amount && p.description_clean === descClean && p.posted_date >= lo && p.posted_date <= hi,
      );
      if (matchIdx !== -1) {
        const match = pendingList[matchIdx];
        pendingList.splice(matchIdx, 1);
        updateStatements.push(env.DB.prepare(
          `UPDATE transactions
           SET import_id=?, teller_transaction_id=?, posted_date=?, amount=?, currency='USD',
               merchant_name=?, description=?, description_clean=?, category_plaid=?,
               is_pending=0, dedup_hash=?
           WHERE id=?`,
        ).bind(importId, tx.id, tx.date, amount, merchant, tx.description, descClean, category, dedupHash, match.id));
        continue;
      }
    }

    // New transaction
    const txId = crypto.randomUUID();
    insertStatements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO transactions
         (id, user_id, account_id, import_id, teller_transaction_id,
          posted_date, amount, currency, merchant_name, description,
          description_clean, category_plaid, is_pending, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
    ).bind(txId, userId, accountId, importId, tx.id, tx.date, amount, merchant, tx.description, descClean, category, isPending, dedupHash));
    insertMeta.push({ txId, isPosted: tx.status === 'posted' });
  }

  // Batch updates (fire-and-forget result)
  for (let i = 0; i < updateStatements.length; i += BATCH) {
    await env.DB.batch(updateStatements.slice(i, i + BATCH));
  }

  // Batch inserts — check results to build review queue entries only for rows that landed
  let added = 0;
  let dupes = 0;
  const reviewStatements: D1PreparedStatement[] = [];
  for (let i = 0; i < insertStatements.length; i += BATCH) {
    const results = await env.DB.batch(insertStatements.slice(i, i + BATCH));
    for (let j = 0; j < results.length; j++) {
      const meta = insertMeta[i + j];
      if (results[j].meta.changes > 0) {
        if (meta.isPosted) {
          added++;
          reviewStatements.push(env.DB.prepare(
            `INSERT OR IGNORE INTO review_queue
               (id, transaction_id, user_id, reason, confidence, details, needs_input)
             VALUES (?, ?, ?, 'unclassified', NULL,
               'No rule match or saved classification exists for this transaction yet.',
               'A clearer merchant name, notes, or a manual classification for a similar transaction would help future matches.')`,
          ).bind(crypto.randomUUID(), meta.txId, userId));
        }
      } else {
        dupes++;
      }
    }
  }

  // Batch review queue inserts
  for (let i = 0; i < reviewStatements.length; i += BATCH) {
    await env.DB.batch(reviewStatements.slice(i, i + BATCH));
  }

  return { added, dupes };
}

async function removeMissingPendingTransactions(
  env: Env,
  accountId: string,
  startDate: string | null,
  endDate: string,
  seenTransactionIds: Set<string>,
): Promise<void> {
  const existingPending = startDate
    ? await env.DB.prepare(
        `SELECT id, teller_transaction_id
         FROM transactions
         WHERE account_id = ?
           AND teller_transaction_id IS NOT NULL
           AND is_pending = 1
           AND posted_date BETWEEN ? AND ?`,
      ).bind(accountId, startDate, endDate).all<{ id: string; teller_transaction_id: string | null }>()
    : await env.DB.prepare(
        `SELECT id, teller_transaction_id
         FROM transactions
         WHERE account_id = ?
           AND teller_transaction_id IS NOT NULL
           AND is_pending = 1`,
      ).bind(accountId).all<{ id: string; teller_transaction_id: string | null }>();

  const toDelete = existingPending.results.filter(
    r => r.teller_transaction_id && !seenTransactionIds.has(r.teller_transaction_id),
  );
  if (toDelete.length === 0) return;

  const BATCH = 100;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    await env.DB.batch(
      toDelete.slice(i, i + BATCH).map(r => env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(r.id)),
    );
  }
}

export function getTellerBankConfig(env: Env): {
  provider: 'teller';
  application_id: string;
  environment: string;
  products: string[];
  select_account: 'multiple';
} {
  const config = getTellerConnectConfig(env);
  return {
    provider: 'teller',
    ...config,
  };
}

export async function connectTellerEnrollmentForUser(
  env: Env,
  userId: string,
  payload: TellerEnrollmentPayload,
): Promise<{ enrollment_id: string; institution: string | null; accounts_linked: number; message: string }> {
  const accounts = await listAccounts(env, payload.access_token);
  const supportedAccounts = accounts.filter((account) => account.status === 'open' && Boolean(account.links.transactions));
  if (!supportedAccounts.length) {
    throw new Error('Teller enrollment completed, but no transaction-capable accounts were returned.');
  }

  const tellerEnrollmentId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO teller_enrollments (id, user_id, enrollment_id, access_token, institution_id, institution_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(enrollment_id) DO UPDATE SET
       access_token=excluded.access_token,
       institution_id=COALESCE(excluded.institution_id, teller_enrollments.institution_id),
       institution_name=COALESCE(excluded.institution_name, teller_enrollments.institution_name)`,
  ).bind(
    tellerEnrollmentId,
    userId,
    payload.enrollment_id,
    payload.access_token,
    payload.institution_id ?? null,
    payload.institution_name ?? null,
  ).run();

  const enrollment = await env.DB.prepare(
    'SELECT id FROM teller_enrollments WHERE enrollment_id = ?',
  ).bind(payload.enrollment_id).first<{ id: string }>();
  if (!enrollment) throw new Error('Failed to save Teller enrollment');

  const institutionName = payload.institution_name
    ?? supportedAccounts[0]?.institution.name
    ?? null;
  const institutionId = payload.institution_id
    ?? supportedAccounts[0]?.institution.id
    ?? null;

  await env.DB.prepare(
    `UPDATE teller_enrollments
     SET institution_id = COALESCE(?, institution_id),
         institution_name = COALESCE(?, institution_name)
     WHERE id = ?`,
  ).bind(institutionId, institutionName, enrollment.id).run();

  for (const account of supportedAccounts) {
    const existingAccount = await env.DB.prepare(
      'SELECT id FROM accounts WHERE teller_account_id = ?',
    ).bind(account.id).first<{ id: string }>();

    if (existingAccount) {
      await env.DB.prepare(
        `UPDATE accounts
         SET teller_enrollment_id=?,
             name=?,
             mask=?,
             type=?,
             subtype=?,
             is_active=1
         WHERE teller_account_id=?`,
      ).bind(
        enrollment.id,
        account.name,
        account.last_four ?? null,
        account.type,
        account.subtype ?? null,
        account.id,
      ).run();
      continue;
    }

    const accountId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO accounts
         (id, teller_enrollment_id, user_id, teller_account_id, name, mask, type, subtype)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      accountId,
      enrollment.id,
      userId,
      account.id,
      account.name,
      account.last_four ?? null,
      account.type,
      account.subtype ?? null,
    ).run();
  }

  return {
    enrollment_id: payload.enrollment_id,
    institution: institutionName,
    accounts_linked: supportedAccounts.length,
    message: 'Accounts connected. Call POST /bank/sync to import transactions.',
  };
}

export async function syncTellerTransactionsForUser(
  env: Env,
  userId: string,
  dateFrom: string | null,
  dateTo: string | null,
  accountIds?: string[],
): Promise<TellerSyncSummary> {
  const enrollments = await env.DB.prepare(
    `SELECT id, access_token, institution_name, last_synced_at
     FROM teller_enrollments
     WHERE user_id = ?`,
  ).bind(userId).all<{ id: string; access_token: string; institution_name: string | null; last_synced_at: string | null }>();

  if (!enrollments.results.length) {
    throw new Error('No linked Teller accounts found. Connect an account first.');
  }

  const syncEnd = dateTo ?? todayIsoDate();
  let totalAdded = 0;
  let totalDupes = 0;
  const syncedAccountIds = new Set<string>();
  const byInstitution: Array<{ institution: string | null; added: number; dupes: number }> = [];
  const requestedAccountIds = new Set(accountIds ?? []);
  let matchedRequestedAccounts = 0;

  for (const enrollment of enrollments.results) {
    const syncStart = dateFrom;
    const importId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO imports (id, user_id, source, status, date_from, date_to, tax_year)
       VALUES (?, ?, 'teller', 'running', ?, ?, ?)`,
    ).bind(importId, userId, syncStart ?? null, syncEnd, syncStart ? parseInt(syncStart.slice(0, 4), 10) : null).run();

    let added = 0;
    let dupes = 0;
    let found = 0;

    try {
      const accounts = await env.DB.prepare(
        `SELECT id, teller_account_id
         FROM accounts
         WHERE user_id = ?
           AND teller_enrollment_id = ?
           AND is_active = 1
           AND teller_account_id IS NOT NULL`,
      ).bind(userId, enrollment.id).all<{ id: string; teller_account_id: string }>();

      for (const account of accounts.results) {
        if (requestedAccountIds.size > 0 && !requestedAccountIds.has(account.id)) continue;
        matchedRequestedAccounts++;
        syncedAccountIds.add(account.id);
        const transactions = await listTransactions(
          env,
          enrollment.access_token,
          account.teller_account_id,
          { startDate: syncStart ?? undefined, endDate: syncEnd },
        );
        found += transactions.length;

        const seenTransactionIds = new Set(transactions.map(t => t.id));
        const result = await syncAccountTransactions(env, userId, account.id, account.teller_account_id, importId, transactions);
        added += result.added;
        dupes += result.dupes;

        await removeMissingPendingTransactions(
          env,
          account.id,
          syncStart,
          syncEnd,
          seenTransactionIds,
        );
      }

      await env.DB.prepare(
        `UPDATE teller_enrollments SET last_synced_at=datetime('now') WHERE id = ?`,
      ).bind(enrollment.id).run();

      await env.DB.prepare(
        `UPDATE imports
         SET status='completed', transactions_found=?, transactions_imported=?, completed_at=datetime('now')
         WHERE id=?`,
      ).bind(found, added, importId).run();
    } catch (err) {
      await env.DB.prepare(
        `UPDATE imports SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`,
      ).bind(String(err), importId).run();
    }

    totalAdded += added;
    totalDupes += dupes;
    byInstitution.push({ institution: enrollment.institution_name, added, dupes });
  }

  if (requestedAccountIds.size > 0 && matchedRequestedAccounts === 0) {
    throw new Error('No linked Teller accounts matched the requested sync scope.');
  }

  return {
    transactions_imported: totalAdded,
    duplicates_skipped: totalDupes,
    by_institution: byInstitution,
    account_ids_synced: [...syncedAccountIds],
    message: 'Sync complete. New transactions are queued for review.',
  };
}
