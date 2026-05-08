// Fetch wrappers for /api/web/* AND for the legacy REST surface
// (/transactions, /review, /accounts, etc.). Same-origin so the cookie
// set by /login authorises every call. 401 → bounce to /login.

import type {
  ChatMessage, ChatStreamEvent, Snapshot,
  ReviewListResponse, ReviewItem, ResolveAction, BulkResolveInput,
  Account, BankConfig,
  Transaction, TransactionListResponse, TransactionDetail, TransactionSplit, EntitySlug,
  ImportRecord, CsvImportResult, AmazonImportResult, TillerImportResult, DeleteImportsResult,
  Rule, RuleMatchField, RuleMatchOperator, AutoCatImportResult,
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

// Multipart form upload — let the browser set the content-type with boundary.
async function uploadForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    body: form,
    credentials: "same-origin",
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

// ── Accounts & bank connect ───────────────────────────────────────────────

export async function getBankConfig(): Promise<BankConfig> {
  return request<BankConfig>("/bank/config");
}

export interface TellerConnectConfig {
  provider: string;
  application_id: string;
  environment: string;
  products: string[];
  select_account: string;
}

export async function startBankConnect(): Promise<TellerConnectConfig> {
  return request<TellerConnectConfig>("/bank/connect/start", { method: "POST", body: JSON.stringify({}) });
}

export interface ConnectCompletePayload {
  access_token: string;
  enrollment_id: string;
  institution_name: string | null;
  institution_id: string | null;
}

export interface ConnectCompleteResult {
  enrollment_id: string;
  institution: string | null;
  accounts_linked: number;
  message: string;
}

export async function completeBankConnect(payload: ConnectCompletePayload): Promise<ConnectCompleteResult> {
  return request<ConnectCompleteResult>("/bank/connect/complete", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface SyncResult {
  transactions_imported: number;
  duplicates_skipped: number;
  message: string;
}

export async function bankSync(account_ids?: string[]): Promise<SyncResult> {
  const body = account_ids?.length ? { account_ids } : {};
  return request<SyncResult>("/bank/sync", { method: "POST", body: JSON.stringify(body) });
}

export async function listAccounts(): Promise<{ accounts: Account[] }> {
  return request<{ accounts: Account[] }>("/accounts");
}

export async function updateAccount(
  id: string,
  patch: { owner_tag?: string | null; name?: string; is_active?: boolean },
): Promise<{ account: Account }> {
  return request<{ account: Account }>(`/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ── Transactions ──────────────────────────────────────────────────────────

export interface ListTransactionsParams {
  entity?: EntitySlug;
  category_tax?: string;
  account_id?: string;
  date_from?: string;
  date_to?: string;
  review_required?: boolean;
  unclassified?: boolean;
  limit?: number;
  offset?: number;
}

export async function listTransactions(params: ListTransactionsParams = {}): Promise<TransactionListResponse> {
  const qs = new URLSearchParams();
  if (params.entity) qs.set("entity", params.entity);
  if (params.category_tax) qs.set("category_tax", params.category_tax);
  if (params.account_id) qs.set("account_id", params.account_id);
  if (params.date_from) qs.set("date_from", params.date_from);
  if (params.date_to) qs.set("date_to", params.date_to);
  if (params.review_required != null) qs.set("review_required", String(params.review_required));
  if (params.unclassified) qs.set("unclassified", "true");
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  return request<TransactionListResponse>(`/transactions?${qs.toString()}`);
}

export async function getTransaction(id: string): Promise<TransactionDetail> {
  return request<TransactionDetail>(`/transactions/${encodeURIComponent(id)}`);
}

export interface ClassifyTransactionInput {
  entity: EntitySlug;
  category_tax: string;
  category_budget?: string;
  note?: string;
}

export async function classifyTransaction(id: string, input: ClassifyTransactionInput): Promise<{ transaction: Transaction }> {
  return request<{ transaction: Transaction }>(`/transactions/${encodeURIComponent(id)}/classify`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface SplitItem {
  entity: EntitySlug;
  category_tax?: string;
  amount: number;
  note?: string;
}

export async function splitTransaction(id: string, splits: SplitItem[]): Promise<{ splits: TransactionSplit[] }> {
  return request<{ splits: TransactionSplit[] }>(`/transactions/${encodeURIComponent(id)}/split`, {
    method: "POST",
    body: JSON.stringify(splits),
  });
}

export async function deleteTransaction(id: string): Promise<{ deleted: true; transaction_id: string }> {
  return request(`/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── Imports ───────────────────────────────────────────────────────────────

export async function listImports(): Promise<{ imports: ImportRecord[] }> {
  return request<{ imports: ImportRecord[] }>("/imports");
}

export interface CsvImportInput {
  file: File;
  format?: "auto" | "generic" | "venmo" | "chase" | "amex" | "bofa";
  account_id?: string;
}

export async function importCsv(input: CsvImportInput): Promise<CsvImportResult> {
  const form = new FormData();
  form.append("file", input.file);
  if (input.format) form.append("format", input.format);
  if (input.account_id) form.append("account_id", input.account_id);
  return uploadForm<CsvImportResult>("/imports/csv", form);
}

export async function importAmazon(file: File): Promise<AmazonImportResult> {
  const form = new FormData();
  form.append("file", file);
  return uploadForm<AmazonImportResult>("/imports/amazon", form);
}

export async function importTiller(file: File): Promise<TillerImportResult> {
  const form = new FormData();
  form.append("file", file);
  return uploadForm<TillerImportResult>("/imports/tiller", form);
}

export async function deleteImport(id: string): Promise<DeleteImportsResult> {
  return request<DeleteImportsResult>(`/imports/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function deleteAllImports(): Promise<DeleteImportsResult> {
  return request<DeleteImportsResult>(`/imports`, { method: "DELETE" });
}

// ── Rules ─────────────────────────────────────────────────────────────────

export async function listRules(): Promise<{ rules: Rule[] }> {
  return request<{ rules: Rule[] }>("/rules");
}

export interface RuleInput {
  name: string;
  match_field: RuleMatchField;
  match_operator: RuleMatchOperator;
  match_value: string;
  entity: EntitySlug;
  category_tax?: string;
  category_budget?: string;
  priority?: number;
  is_active?: boolean;
}

export async function createRule(input: RuleInput): Promise<{ rule: Rule }> {
  return request<{ rule: Rule }>("/rules", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateRule(id: string, patch: Partial<RuleInput>): Promise<{ rule: Rule }> {
  return request<{ rule: Rule }>(`/rules/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function deleteRule(id: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(`/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function importAutoCat(file: File): Promise<AutoCatImportResult> {
  const form = new FormData();
  form.append("file", file);
  return uploadForm<AutoCatImportResult>("/rules/import-autocat", form);
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
