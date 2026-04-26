// Fetch wrappers for /api/web/* AND for the legacy REST surface
// (/transactions, /review, /accounts, etc.). Same-origin so the cookie
// set by /login authorises every call. 401 → bounce to /login.

import type {
  ChatMessage, ChatStreamEvent, Snapshot,
  ReviewListResponse, ReviewItem, ResolveAction, BulkResolveInput,
  Account, AccountListResponse, BankConfig, TaxYearWorkflow,
  TransactionListResponse,
} from "./types";

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("unauthorized");
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "error" in data)
      ? String((data as Record<string, unknown>).error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export async function getSnapshot(): Promise<Snapshot> {
  return request<Snapshot>("/api/web/snapshot");
}

// ── Review queue ─────────────────────────────────────────────────────────
// The legacy REST surface still uses X-User-Id header auth. The cookie
// session doesn't carry one, so the worker needs to recognize the cookie
// for /review/* etc. — for now the kit's session cookie is checked at the
// route level, but legacy endpoints fall back to header auth. We forward
// X-User-Id from the env-pinned WEB_UI_USER_ID via a server proxy to
// avoid clients ever needing to know it.
//
// Practically: until we wire that proxy, /review etc. work because the
// worker treats the cookie as "user_id=default" implicitly via getUserId
// (which defaults to 'default' when no header is present).

export interface ListReviewParams {
  status?: "pending" | "resolved" | "skipped";
  category_tax?: string;
  limit?: number;
  offset?: number;
}

export async function listReview(params: ListReviewParams = {}): Promise<ReviewListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.category_tax) qs.set("category_tax", params.category_tax);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  return request<ReviewListResponse>(`/review?${qs.toString()}`);
}

export interface ResolveReviewInput {
  action: ResolveAction;
  entity?: string;
  category_tax?: string;
  category_budget?: string;
}

export async function resolveReview(id: string, input: ResolveReviewInput): Promise<{ ok: true }> {
  return request(`/review/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function bulkResolveReview(input: BulkResolveInput): Promise<{ updated: number }> {
  return request(`/review/bulk`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface ClassifyRunResult {
  total?: number;
  rules?: number;
  ai?: number;
  review_required?: number;
  [k: string]: unknown;
}

export async function runClassification(): Promise<ClassifyRunResult> {
  return request(`/classify/run`, { method: "POST", body: JSON.stringify({}) });
}

export async function getNextReviewItem(): Promise<ReviewItem | { empty: true; message: string }> {
  return request<ReviewItem | { empty: true; message: string }>("/review/next");
}

// ── Accounts + bank ──────────────────────────────────────────────────────

export async function listAccounts(): Promise<AccountListResponse> {
  return request<AccountListResponse>("/accounts");
}

export async function updateAccount(id: string, patch: Partial<Pick<Account, "name" | "owner_tag" | "is_active">>): Promise<{ ok: true }> {
  return request(`/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function getBankConfig(): Promise<BankConfig> {
  return request<BankConfig>("/bank/config");
}

export async function startBankConnect(provider: "teller" | "plaid"): Promise<BankConfig> {
  return request<BankConfig>("/bank/connect/start", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export async function completeBankConnect(input: Record<string, unknown>): Promise<{ accounts_linked: number; institution?: string | null }> {
  return request("/bank/connect/complete", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function bankSync(input: { provider: "teller" | "plaid"; account_ids?: string[] }): Promise<{
  provider: string;
  transactions_imported: number;
  duplicates_skipped: number;
  account_ids_synced?: string[];
  accounts_synced?: number;
}> {
  return request("/bank/sync", { method: "POST", body: JSON.stringify(input) });
}

// ── Tax-year workflow ────────────────────────────────────────────────────

export async function getTaxYearWorkflow(): Promise<TaxYearWorkflow> {
  return request<TaxYearWorkflow>("/workflow/tax-year");
}

export async function createTaxYearWorkflow(input: { tax_year: number }): Promise<TaxYearWorkflow> {
  return request<TaxYearWorkflow>("/workflow/tax-year", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ── Transactions ─────────────────────────────────────────────────────────

export interface ListTransactionsParams {
  limit?: number;
  offset?: number;
  account_id?: string;
  category_tax?: string;
  entity?: string;
  q?: string;            // search merchant/description
  start?: string;        // YYYY-MM-DD
  end?: string;
}

export async function listTransactions(params: ListTransactionsParams = {}): Promise<TransactionListResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, String(v));
  }
  return request<TransactionListResponse>(`/transactions?${qs.toString()}`);
}

export async function getTransaction(id: string): Promise<Record<string, unknown>> {
  return request(`/transactions/${encodeURIComponent(id)}`);
}

export async function classifyTransaction(id: string, input: { entity?: string; category_tax?: string; category_budget?: string }): Promise<{ ok: true }> {
  return request(`/transactions/${encodeURIComponent(id)}/classify`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function splitTransaction(id: string, input: {
  splits: Array<{ amount: number; entity: string; category_tax?: string; category_budget?: string; description?: string }>;
}): Promise<{ ok: true }> {
  return request(`/transactions/${encodeURIComponent(id)}/split`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ── Chat (SSE) ────────────────────────────────────────────────────────────

export interface ChatStreamInput {
  message: string;
  history: ChatMessage[];
}

export async function sendChatStream(
  input: ChatStreamInput,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/web/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(input),
    credentials: "same-origin",
    signal,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed?.error) msg = String(parsed.error);
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  if (!res.body) throw new Error("response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      try {
        const parsed = JSON.parse(data) as ChatStreamEvent;
        onEvent(parsed);
      } catch (err) {
        console.warn("malformed SSE frame", err, data);
      }
    }
  }
}
