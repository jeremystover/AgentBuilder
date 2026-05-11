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
  TaxCategory, BudgetCategory, BudgetTarget, BudgetStatusResponse, BudgetForecastResponse, CutsReportResponse,
  BudgetCadence, IncomeCadence, BudgetPreset,
  IncomeTarget, IncomeStatusResponse,
  ScheduleReport, ScheduleCEntity, SummaryReport,
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
  q?: string;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function listReview(params: ListReviewParams = {}): Promise<ReviewListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.category_tax) qs.set("category_tax", params.category_tax);
  if (params.q) qs.set("q", params.q);
  if (params.sort_by) qs.set("sort_by", params.sort_by);
  if (params.sort_dir) qs.set("sort_dir", params.sort_dir);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  return request<ReviewListResponse>(`/review?${qs.toString()}`);
}

export interface ResolveReviewInput {
  action: ResolveAction;
  entity?: string;
  category_tax?: string;
  category_budget?: string;
  expense_type?: "recurring" | "one_time" | null;
  cut_status?: "flagged" | "complete" | null;
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
  total_processed?: number;
  classified_by_rules?: number;
  classified_by_ai?: number;
  queued_for_review?: number;
  ai_errors?: number;
  [k: string]: unknown;
}

export async function runClassification(transactionIds?: string[]): Promise<ClassifyRunResult> {
  return request(`/classify/run`, {
    method: "POST",
    body: JSON.stringify(transactionIds ? { transaction_ids: transactionIds } : {}),
  });
}

export async function getNextReviewItem(): Promise<ReviewItem | { empty: true; message: string }> {
  return request<ReviewItem | { empty: true; message: string }>("/review/next");
}

// ── Accounts & bank connect ───────────────────────────────────────────────

export async function getBankConfig(): Promise<BankConfig> {
  return request<BankConfig>("/bank/config");
}

export interface BankConnectStartPayload {
  provider?: "teller" | "plaid";
  institution_key?: string; // Plaid only: our internal key (e.g. 'patelco')
}

export type BankConnectConfig = Record<string, unknown>; // varies by provider

export async function startBankConnect(payload: BankConnectStartPayload = {}): Promise<BankConnectConfig> {
  return request<BankConnectConfig>("/bank/connect/start", { method: "POST", body: JSON.stringify(payload) });
}

export interface ConnectCompletePayload {
  provider?: "teller" | "plaid";
  // Teller fields
  access_token?: string;
  enrollment_id?: string;
  // Plaid fields
  public_token?: string;
  institution_key?: string;
  plaid_institution_id?: string | null;
  // Shared
  institution_name: string | null;
  institution_id?: string | null;
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
  category_budget?: string;
  account_id?: string;
  date_from?: string;
  date_to?: string;
  review_required?: boolean;
  unclassified?: boolean;
  cut_status?: "flagged" | "complete" | "any" | "none";
  q?: string;
  sort_by?: string;
  sort_dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function listTransactions(params: ListTransactionsParams = {}): Promise<TransactionListResponse> {
  const qs = new URLSearchParams();
  if (params.entity) qs.set("entity", params.entity);
  if (params.category_tax) qs.set("category_tax", params.category_tax);
  if (params.category_budget) qs.set("category_budget", params.category_budget);
  if (params.account_id) qs.set("account_id", params.account_id);
  if (params.date_from) qs.set("date_from", params.date_from);
  if (params.date_to) qs.set("date_to", params.date_to);
  if (params.review_required != null) qs.set("review_required", String(params.review_required));
  if (params.unclassified) qs.set("unclassified", "true");
  if (params.cut_status) qs.set("cut_status", params.cut_status);
  if (params.q) qs.set("q", params.q);
  if (params.sort_by) qs.set("sort_by", params.sort_by);
  if (params.sort_dir) qs.set("sort_dir", params.sort_dir);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  return request<TransactionListResponse>(`/transactions?${qs.toString()}`);
}

export async function getTransaction(id: string): Promise<TransactionDetail> {
  return request<TransactionDetail>(`/transactions/${encodeURIComponent(id)}`);
}

export interface ClassifyTransactionInput {
  entity?: EntitySlug;
  category_tax: string;
  category_budget?: string;
  expense_type?: "recurring" | "one_time" | null;
  cut_status?: "flagged" | "complete" | null;
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

export interface ReclassifyResult {
  method: "rule" | "ai";
  rule?: string;
  entity?: string;
  category_tax?: string;
  category_budget?: string | null;
  classification?: unknown;
  _debug?: {
    userMessage: string;
    pass: string;
    rawResponse: unknown;
  };
}

export async function reclassifyWithAI(id: string): Promise<ReclassifyResult> {
  return request<ReclassifyResult>(`/classify/transaction/${encodeURIComponent(id)}`, { method: "POST" });
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
  entity?: EntitySlug;
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

export async function applyRuleRetroactive(id: string): Promise<{ applied: number; total_eligible: number }> {
  return request<{ applied: number; total_eligible: number }>(`/rules/${encodeURIComponent(id)}/apply-retroactive`, { method: "POST" });
}

export async function importAutoCat(file: File): Promise<AutoCatImportResult> {
  const form = new FormData();
  form.append("file", file);
  return uploadForm<AutoCatImportResult>("/rules/import-autocat", form);
}

// ── Tax categories ────────────────────────────────────────────────────────

export async function listTaxCategories(): Promise<{ categories: TaxCategory[] }> {
  return request<{ categories: TaxCategory[] }>("/tax/categories");
}

export interface CreateTaxCategoryInput {
  slug: string;
  name: string;
  form_line?: string;
  category_group: "schedule_c" | "schedule_e";
}

export async function createTaxCategory(input: CreateTaxCategoryInput): Promise<TaxCategory> {
  return request<TaxCategory>("/tax/categories", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdateTaxCategoryInput {
  name?: string;
  form_line?: string | null;
  is_active?: boolean;
}

export async function updateTaxCategory(slug: string, patch: UpdateTaxCategoryInput): Promise<{ slug: string; updated: UpdateTaxCategoryInput }> {
  return request(`/tax/categories/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ── Budget ────────────────────────────────────────────────────────────────

export async function listBudgetCategories(): Promise<{ categories: BudgetCategory[] }> {
  return request<{ categories: BudgetCategory[] }>("/budget/categories");
}

export interface CreateBudgetCategoryInput {
  slug: string;
  name: string;
  parent_slug?: string;
}

export async function createBudgetCategory(input: CreateBudgetCategoryInput): Promise<BudgetCategory> {
  return request<BudgetCategory>("/budget/categories", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdateBudgetCategoryInput {
  name?: string;
  parent_slug?: string | null;
  is_active?: boolean;
}

export async function updateBudgetCategory(slug: string, patch: UpdateBudgetCategoryInput): Promise<{ slug: string; updated: UpdateBudgetCategoryInput }> {
  return request(`/budget/categories/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function listBudgetTargets(): Promise<{ targets: BudgetTarget[] }> {
  return request<{ targets: BudgetTarget[] }>("/budget/targets");
}

export interface UpsertBudgetTargetInput {
  category_slug: string;
  cadence: BudgetCadence;
  amount: number;
  effective_from?: string;
  effective_to?: string | null;
  notes?: string;
}

export async function upsertBudgetTarget(input: UpsertBudgetTargetInput): Promise<{ id: string; category_slug: string; cadence: BudgetCadence; amount: number }> {
  return request("/budget/targets", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteBudgetTarget(id: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(`/budget/targets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface BudgetStatusParams {
  preset?: BudgetPreset;
  start?: string;
  end?: string;
  category_slug?: string;
}

export async function getBudgetStatus(params: BudgetStatusParams = {}): Promise<BudgetStatusResponse> {
  const qs = new URLSearchParams();
  if (params.preset) qs.set("preset", params.preset);
  if (params.start) qs.set("start", params.start);
  if (params.end) qs.set("end", params.end);
  if (params.category_slug) qs.set("category_slug", params.category_slug);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<BudgetStatusResponse>(`/budget/status${suffix}`);
}

export async function getBudgetForecast(): Promise<BudgetForecastResponse> {
  return request<BudgetForecastResponse>("/budget/forecast");
}

export async function getCutsReport(): Promise<CutsReportResponse> {
  return request<CutsReportResponse>("/budget/cuts");
}

// ── Income ────────────────────────────────────────────────────────────────

export interface IncomeStatusParams {
  preset?: BudgetPreset;
  start?: string;
  end?: string;
}

export async function getIncomeStatus(params: IncomeStatusParams = {}): Promise<IncomeStatusResponse> {
  const qs = new URLSearchParams();
  if (params.preset) qs.set("preset", params.preset);
  if (params.start) qs.set("start", params.start);
  if (params.end) qs.set("end", params.end);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<IncomeStatusResponse>(`/income/status${suffix}`);
}

export async function listIncomeTargets(): Promise<{ targets: IncomeTarget[] }> {
  return request<{ targets: IncomeTarget[] }>("/income/targets");
}

export interface UpsertIncomeTargetInput {
  entity: EntitySlug;
  cadence: IncomeCadence;
  amount: number;
  effective_from?: string;
  notes?: string;
}

export async function upsertIncomeTarget(input: UpsertIncomeTargetInput): Promise<{ target: IncomeTarget }> {
  return request("/income/targets", { method: "PUT", body: JSON.stringify(input) });
}

export async function deleteIncomeTarget(id: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(`/income/targets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── Reports ───────────────────────────────────────────────────────────────

export async function getScheduleC(year: string, entity: ScheduleCEntity): Promise<ScheduleReport> {
  const qs = new URLSearchParams({ year, entity });
  return request<ScheduleReport>(`/reports/schedule-c?${qs.toString()}`);
}

export async function getScheduleE(year: string): Promise<ScheduleReport> {
  const qs = new URLSearchParams({ year });
  return request<ScheduleReport>(`/reports/schedule-e?${qs.toString()}`);
}

export async function getSummaryReport(year: string): Promise<SummaryReport> {
  const qs = new URLSearchParams({ year });
  return request<SummaryReport>(`/reports/summary?${qs.toString()}`);
}

// CSV export endpoint URL — used as an <a href> for download.
export function reportExportUrl(year: string, entity?: string): string {
  const qs = new URLSearchParams({ year });
  if (entity) qs.set("entity", entity);
  return `/reports/export?${qs.toString()}`;
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
