import type { Env } from '../types';

const PLAID_URLS: Record<string, string> = {
  sandbox:    'https://sandbox.plaid.com',
  development:'https://development.plaid.com',
  production: 'https://production.plaid.com',
};

async function plaidPost<T>(env: Env, endpoint: string, body: Record<string, unknown>): Promise<T> {
  const base = PLAID_URLS[env.PLAID_ENV] ?? PLAID_URLS.sandbox;
  const res = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID,
      'PLAID-SECRET': env.PLAID_SECRET,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as T & { error_code?: string; error_message?: string };
  if (!res.ok) {
    throw new Error(`Plaid ${endpoint} failed: ${data.error_code ?? res.status} – ${data.error_message ?? ''}`);
  }
  return data;
}

// ── Link token (frontend uses this to open Plaid Link) ───────────────────────
export async function createLinkToken(env: Env, userId: string): Promise<{ link_token: string; expiration: string }> {
  return plaidPost(env, '/link/token/create', {
    user: { client_user_id: userId },
    client_name: 'Tax Prep',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
  });
}

// ── Exchange public token for permanent access token ─────────────────────────
export async function exchangePublicToken(
  env: Env,
  publicToken: string,
): Promise<{ access_token: string; item_id: string }> {
  return plaidPost(env, '/item/public_token/exchange', { public_token: publicToken });
}

// ── Get item metadata ────────────────────────────────────────────────────────
export interface PlaidItem {
  item_id: string;
  institution_id: string | null;
}
export async function getItem(env: Env, accessToken: string): Promise<{ item: PlaidItem }> {
  return plaidPost(env, '/item/get', { access_token: accessToken });
}

// ── Get institution name ─────────────────────────────────────────────────────
export async function getInstitution(env: Env, institutionId: string): Promise<{ institution: { name: string } }> {
  return plaidPost(env, '/institutions/get_by_id', {
    institution_id: institutionId,
    country_codes: ['US'],
  });
}

// ── Get accounts for an item ─────────────────────────────────────────────────
export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
}
export async function getAccounts(env: Env, accessToken: string): Promise<{ accounts: PlaidAccount[] }> {
  return plaidPost(env, '/accounts/get', { access_token: accessToken });
}

// ── Incremental transaction sync ─────────────────────────────────────────────
export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  date: string;
  authorized_date: string | null;
  amount: number;
  iso_currency_code: string | null;
  merchant_name: string | null;
  name: string;
  category: string[] | null;
  pending: boolean;
}

export interface SyncResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}

export async function syncTransactions(env: Env, accessToken: string, cursor?: string | null): Promise<SyncResult> {
  const body: Record<string, unknown> = { access_token: accessToken };
  if (cursor) body.cursor = cursor;
  return plaidPost(env, '/transactions/sync', body);
}

// ── Sandbox only: create a public_token without going through Link UI ─────────
export async function sandboxCreatePublicToken(
  env: Env,
  institutionId = 'ins_109508', // Chase sandbox
): Promise<{ public_token: string }> {
  if (env.PLAID_ENV !== 'sandbox') throw new Error('Only available in sandbox environment');
  return plaidPost(env, '/sandbox/public_token/create', {
    institution_id: institutionId,
    initial_products: ['transactions'],
  });
}
