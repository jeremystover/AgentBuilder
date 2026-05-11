import type { Env } from '../types';

const PLAID_BASE: Record<string, string> = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};

// Fixed set of institutions supported for Plaid connection.
//
// Plaid ins_* IDs are not publicly indexed. Use your Plaid Dashboard
// (dashboard.plaid.com) or POST /institutions/search to look them up,
// then populate plaid_id to pre-select the institution in Plaid Link.
// When plaid_id is null the user searches by name inside Plaid Link.
//
// Excluded:
//   Venmo — cannot be connected as a source in Plaid Link; Venmo uses
//           Plaid to verify external banks, not the other way around.
//   Northwestern Mutual — Plaid integration discontinued July 31, 2025.
export const PLAID_INSTITUTIONS: ReadonlyArray<{
  key: string;
  name: string;
  plaid_id: string | null;
}> = [
  { key: 'patelco',  name: 'Patelco Credit Union', plaid_id: null },
  { key: 'eastrise', name: 'EastRise Credit Union', plaid_id: null },
];

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  authorized_date: string | null;
  amount: number; // Plaid: positive = debit (money out), negative = credit (money in)
  name: string;
  merchant_name: string | null;
  pending: boolean;
  personal_finance_category: { primary: string; detailed: string } | null;
}

export interface PlaidSyncResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}

function getPlaidBase(env: Env): string {
  const e = env.PLAID_ENV ?? 'sandbox';
  return PLAID_BASE[e] ?? PLAID_BASE.sandbox;
}

function requirePlaidCreds(env: Env): { client_id: string; secret: string } {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be configured.');
  }
  return { client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET };
}

async function plaidPost<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T> {
  const creds = requirePlaidCreds(env);
  const res = await fetch(`${getPlaidBase(env)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...creds, ...body }),
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const code = data.error_code ?? String(res.status);
    const message = data.error_message ?? res.statusText;
    throw new Error(`Plaid ${path} failed: ${code} - ${message}`);
  }

  return data as T;
}

export function isPlaidConfigured(env: Env): boolean {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
}

export function getPlaidInstitutionByKey(key: string) {
  return PLAID_INSTITUTIONS.find(i => i.key === key);
}

// Creates a Plaid Link token. Pass institutionPlaidId to pre-select an
// institution and skip the search step; omit it to show the full picker.
export async function createLinkToken(
  env: Env,
  userId: string,
  institutionPlaidId?: string | null,
): Promise<{ link_token: string; expiration: string }> {
  const body: Record<string, unknown> = {
    user: { client_user_id: userId },
    client_name: 'CFO',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
  };
  if (institutionPlaidId) body.institution_id = institutionPlaidId;

  return plaidPost<{ link_token: string; expiration: string }>(env, '/link/token/create', body);
}

export async function exchangePublicToken(
  env: Env,
  publicToken: string,
): Promise<{ access_token: string; item_id: string }> {
  return plaidPost<{ access_token: string; item_id: string }>(env, '/item/public_token/exchange', {
    public_token: publicToken,
  });
}

export async function getAccounts(env: Env, accessToken: string): Promise<PlaidAccount[]> {
  const res = await plaidPost<{ accounts: PlaidAccount[] }>(env, '/accounts/get', {
    access_token: accessToken,
  });
  return res.accounts;
}

// Cursor-based transaction sync. Pass undefined cursor for the initial call.
// Callers should loop while has_more === true, passing next_cursor each time.
export async function syncTransactions(
  env: Env,
  accessToken: string,
  cursor?: string,
): Promise<PlaidSyncResult> {
  const body: Record<string, unknown> = { access_token: accessToken };
  if (cursor) body.cursor = cursor;
  return plaidPost<PlaidSyncResult>(env, '/transactions/sync', body);
}
