export interface TellerEnv {
  TELLER_APPLICATION_ID: string;
  TELLER_ENV: string;
  TELLER_MTLS?: Fetcher;
}

const TELLER_API_BASE = 'https://api.teller.io';
const DEFAULT_PAGE_SIZE = 500;

export interface TellerEnrollmentPayload {
  access_token: string;
  enrollment_id: string;
  institution_name?: string | null;
  institution_id?: string | null;
}

export interface TellerAccount {
  enrollment_id: string;
  id: string;
  name: string;
  type: string;
  subtype: string | null;
  currency: string;
  last_four: string | null;
  status: 'open' | 'closed';
  institution: {
    id: string;
    name: string;
  };
  links: {
    self?: string;
    balances?: string;
    transactions?: string;
    details?: string;
  };
}

export interface TellerTransaction {
  id: string;
  account_id: string;
  date: string;
  amount: string;
  description: string;
  status: 'posted' | 'pending';
  type: string;
  running_balance: string | null;
  details?: {
    category?: string | null;
    processing_status?: 'pending' | 'complete';
    counterparty?: {
      name?: string | null;
      type?: string | null;
    };
  };
}

interface TellerApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

function getTellerEnvironment(env: TellerEnv): string {
  return env.TELLER_ENV ?? 'sandbox';
}

function requiresMtls(env: TellerEnv): boolean {
  return getTellerEnvironment(env) !== 'sandbox';
}

async function tellerRequest<T>(
  env: TellerEnv,
  accessToken: string,
  path: string,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(`${TELLER_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  const headers: HeadersInit = {
    Accept: 'application/json',
    Authorization: `Basic ${btoa(`${accessToken}:`)}`,
  };

  let res: Response;
  try {
    if (requiresMtls(env)) {
      if (!env.TELLER_MTLS) {
        throw new Error('Teller development/production requires a TELLER_MTLS binding in wrangler.toml.');
      }
      res = await env.TELLER_MTLS.fetch(url.toString(), { method: 'GET', headers, signal: ac.signal });
    } else {
      res = await fetch(url.toString(), { method: 'GET', headers, signal: ac.signal });
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Teller API timed out after 30s: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let data: T | TellerApiErrorResponse | null = null;
  if (raw) {
    try {
      data = JSON.parse(raw) as T | TellerApiErrorResponse;
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const error = data as TellerApiErrorResponse | null;
    const code = error?.error?.code ?? String(res.status);
    const message = error?.error?.message ?? (raw || res.statusText);
    throw new Error(`Teller ${path} failed: ${code} - ${message}`);
  }

  return data as T;
}

export function getTellerConnectConfig(env: TellerEnv): {
  application_id: string;
  environment: string;
  products: string[];
  select_account: 'multiple';
} {
  if (!env.TELLER_APPLICATION_ID) {
    throw new Error('TELLER_APPLICATION_ID is not configured.');
  }

  return {
    application_id: env.TELLER_APPLICATION_ID,
    environment: getTellerEnvironment(env),
    products: ['transactions'],
    select_account: 'multiple',
  };
}

export async function listAccounts(env: TellerEnv, accessToken: string): Promise<TellerAccount[]> {
  return tellerRequest<TellerAccount[]>(env, accessToken, '/accounts');
}

export async function listTransactions(
  env: TellerEnv,
  accessToken: string,
  accountId: string,
  opts: { startDate?: string; endDate?: string; count?: number } = {},
): Promise<TellerTransaction[]> {
  const count = opts.count ?? DEFAULT_PAGE_SIZE;
  const transactions: TellerTransaction[] = [];
  let fromId: string | undefined;

  while (true) {
    const page = await tellerRequest<TellerTransaction[]>(
      env,
      accessToken,
      `/accounts/${accountId}/transactions`,
      {
        count: String(count),
        start_date: opts.startDate,
        end_date: opts.endDate,
        from_id: fromId,
      },
    );

    transactions.push(...page);
    if (page.length < count) break;

    const nextFromId = page[page.length - 1]?.id;
    if (!nextFromId || nextFromId === fromId) break;
    fromId = nextFromId;
  }

  return transactions;
}
