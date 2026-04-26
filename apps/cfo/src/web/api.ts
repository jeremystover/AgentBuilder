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

export interface SplitItem {
  entity: "elyse_coaching" | "jeremy_coaching" | "airbnb_activity" | "family_personal";
  category_tax?: string;
  amount: number;
  note?: string;
}

// Body is the array directly — see SplitItemSchema in
// apps/cfo/src/routes/transactions.ts. Server validates that the abs
// sum matches the transaction's abs amount.
export async function splitTransaction(id: string, splits: SplitItem[]): Promise<{ splits: Array<SplitItem & { id: string }> }> {
  return request(`/transactions/${encodeURIComponent(id)}/split`, {
    method: "POST",
    body: JSON.stringify(splits),
  });
}

// ── Reports ──────────────────────────────────────────────────────────────

export interface ScheduleLine {
  category_tax: string;
  category_name: string | null;
  form_line: string | null;
  total_amount: number;
  transaction_count: number;
}

export interface ScheduleReport {
  tax_year: string;
  entity?: string;
  schedule: "C" | "E";
  income: { categories: ScheduleLine[]; total: number };
  expenses: { categories: ScheduleLine[]; total: number };
  net_profit?: number;
  net_income?: number;
  pending_review: number;
}

export async function getScheduleC(year: string | number, entity: "elyse_coaching" | "jeremy_coaching" = "elyse_coaching"): Promise<ScheduleReport> {
  return request<ScheduleReport>(`/reports/schedule-c?year=${encodeURIComponent(String(year))}&entity=${encodeURIComponent(entity)}`);
}

export async function getScheduleE(year: string | number): Promise<ScheduleReport> {
  return request<ScheduleReport>(`/reports/schedule-e?year=${encodeURIComponent(String(year))}`);
}

export interface SummaryReport {
  tax_year: string;
  by_entity: Array<{ entity: string; total: number; count: number }>;
  by_month: Array<{ month: string; entity: string; total: number }>;
  review_queue: Array<{ status: string; count: number }>;
}

export async function getSummary(year: string | number): Promise<SummaryReport> {
  return request<SummaryReport>(`/reports/summary?year=${encodeURIComponent(String(year))}`);
}

export function exportCsvUrl(year: string | number, entity?: string): string {
  const qs = new URLSearchParams({ year: String(year) });
  if (entity) qs.set("entity", entity);
  return `/reports/export?${qs.toString()}`;
}

export async function takeSnapshot(year: string | number): Promise<{ snapshot_id: string }> {
  return request("/reports/snapshot", { method: "POST", body: JSON.stringify({ year: String(year) }) });
}

// ── Imports ──────────────────────────────────────────────────────────────

export interface ImportRecord {
  id: string;
  source: string;
  account_id: string | null;
  status: string;
  date_from: string | null;
  date_to: string | null;
  transactions_found: number;
  transactions_imported: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function listImports(): Promise<{ imports: ImportRecord[] }> {
  return request("/imports");
}

export async function deleteImport(id: string): Promise<{ ok: true; transactions_deleted: number; locked_transactions_skipped: number }> {
  return request(`/imports/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function deleteAllImports(): Promise<{ ok: true; transactions_deleted: number; locked_transactions_skipped: number }> {
  return request("/imports", { method: "DELETE" });
}

// Imports use multipart/form-data — bypass the JSON request() helper.
async function multipartRequest<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", body });
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

export async function importCsv(file: File, accountId: string): Promise<{ transactions_imported: number; duplicates_skipped: number; [k: string]: unknown }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("account_id", accountId);
  return multipartRequest("/imports/csv", fd);
}

export async function importAmazon(file: File): Promise<{ orders_imported: number; [k: string]: unknown }> {
  const fd = new FormData();
  fd.append("file", file);
  return multipartRequest("/imports/amazon", fd);
}

export async function importTiller(file: File): Promise<{ transactions_imported: number; unmapped_categories?: string[]; [k: string]: unknown }> {
  const fd = new FormData();
  fd.append("file", file);
  return multipartRequest("/imports/tiller", fd);
}

// ── Rules ────────────────────────────────────────────────────────────────

export type RuleMatchField = "merchant_name" | "description" | "account_id" | "amount";
export type RuleMatchOperator = "contains" | "equals" | "starts_with" | "ends_with" | "regex";

export interface Rule {
  id: string;
  user_id: string;
  name: string;
  match_field: RuleMatchField;
  match_operator: RuleMatchOperator;
  match_value: string;
  entity: "elyse_coaching" | "jeremy_coaching" | "airbnb_activity" | "family_personal";
  category_tax: string | null;
  category_budget: string | null;
  priority: number;
  is_active: number;
  created_at: string;
}

export interface RuleInput {
  name: string;
  match_field: RuleMatchField;
  match_operator: RuleMatchOperator;
  match_value: string;
  entity: Rule["entity"];
  category_tax?: string;
  category_budget?: string;
  priority?: number;
  is_active?: boolean;
}

export async function listRules(): Promise<{ rules: Rule[] }> {
  return request("/rules");
}
export async function createRule(input: RuleInput): Promise<{ rule: Rule }> {
  return request("/rules", { method: "POST", body: JSON.stringify(input) });
}
export async function updateRule(id: string, input: Partial<RuleInput>): Promise<{ rule: Rule }> {
  return request(`/rules/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}
export async function deleteRule(id: string): Promise<{ ok: true }> {
  return request(`/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function importAutoCat(file: File): Promise<{ imported: number; skipped: number; [k: string]: unknown }> {
  const fd = new FormData();
  fd.append("file", file);
  return multipartRequest("/rules/import-autocat", fd);
}

// ── Budget ───────────────────────────────────────────────────────────────

export type Cadence = "weekly" | "monthly" | "annual";

export interface BudgetCategory {
  id: string;
  slug: string;
  name: string;
  parent_slug: string | null;
  is_active: number;
  created_at: string;
}

export interface BudgetTarget {
  id: string;
  category_slug: string;
  cadence: Cadence;
  amount: number;
  effective_from: string | null;
  effective_to: string | null;
  notes: string | null;
  category_name?: string | null;
}

export interface BudgetStatus {
  period: { start: string; end: string; days: number; label: string };
  categories: Array<{
    category_slug: string;
    category_name: string;
    target: { native_amount: number; native_cadence: Cadence; prorated_amount: number } | null;
    spent: number;
    tx_count: number;
    remaining: number | null;
    percent_used: number | null;
    status: "no_target" | "over" | "near" | "under";
  }>;
}

export async function listBudgetCategories(): Promise<{ categories: BudgetCategory[] }> {
  return request("/budget/categories");
}
export async function createBudgetCategory(input: { slug: string; name: string; parent_slug?: string }): Promise<{ category: BudgetCategory }> {
  return request("/budget/categories", { method: "POST", body: JSON.stringify(input) });
}
export async function updateBudgetCategory(slug: string, input: { name?: string; parent_slug?: string | null; is_active?: boolean }): Promise<{ category: BudgetCategory }> {
  return request(`/budget/categories/${encodeURIComponent(slug)}`, { method: "PATCH", body: JSON.stringify(input) });
}
export async function listBudgetTargets(): Promise<{ targets: BudgetTarget[] }> {
  return request("/budget/targets");
}
export async function upsertBudgetTarget(input: { category_slug: string; cadence: Cadence; amount: number; effective_from?: string; effective_to?: string | null; notes?: string }): Promise<{ target: BudgetTarget }> {
  return request("/budget/targets", { method: "PUT", body: JSON.stringify(input) });
}
export async function deleteBudgetTarget(id: string): Promise<{ ok: true }> {
  return request(`/budget/targets/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function getBudgetStatus(preset = "this_month"): Promise<BudgetStatus> {
  return request<BudgetStatus>(`/budget/status?preset=${encodeURIComponent(preset)}`);
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
