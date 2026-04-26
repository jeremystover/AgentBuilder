// Wire types shared between the worker (web-api.ts, web-chat.ts) and the
// React SPA. Phase 1 scope only — review queue / transactions / reports
// types arrive in later phases.

export interface SnapshotEntityPnL {
  entity: string;
  income: number;
  expense: number;
  net: number;
}

export interface SnapshotBudgetLine {
  category_slug: string;
  category_name: string;
  spent: number;
  target: number;
  pct: number;
}

export interface Snapshot {
  tax_year: number | null;
  pnl: {
    period_label: string;
    entities: SnapshotEntityPnL[];
    consolidated: { income: number; expense: number; net: number };
  } | null;
  budget: {
    period_label: string;
    lines: SnapshotBudgetLine[];
  } | null;
  review_queue_count: number;
}

// ── Chat ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: unknown;
}

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; toolUseId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "iteration_end"; stopReason: string; hasToolCalls: boolean }
  | { type: "done"; text: string; stopReason: string; iterations: number; messages?: ChatMessage[]; usage?: unknown }
  | { type: "history"; messages: ChatMessage[]; usage: unknown; iterations: number }
  | { type: "error"; message: string };

// ── Review queue ─────────────────────────────────────────────────────────

export type ReviewStatus = "pending" | "resolved" | "skipped";
export type ResolveAction = "accept" | "classify" | "skip" | "reopen";

export interface ReviewItem {
  id: string;
  user_id: string;
  transaction_id: string;
  reason: string;
  status: ReviewStatus;
  suggested_entity: string | null;
  suggested_category_tax: string | null;
  suggested_category_budget: string | null;
  suggested_confidence: number | null;
  details: string | null;
  needs_input: string | null;
  created_at: string;
  resolved_at: string | null;
  // joined
  posted_date: string | null;
  amount: number | null;
  merchant_name: string | null;
  description: string | null;
  account_name: string | null;
  account_type: string | null;
  account_subtype: string | null;
  owner_tag: string | null;
  current_entity: string | null;
  current_category_tax: string | null;
  current_confidence: number | null;
}

export interface ReviewListResponse {
  items: ReviewItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface BulkResolveInput {
  action: ResolveAction;
  review_ids?: string[];
  apply_to_filtered?: boolean;
  status?: ReviewStatus;
  filter_category_tax?: string;
  entity?: string;
  category_tax?: string;
  category_budget?: string;
}

// ── Accounts ─────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  user_id: string;
  name: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  owner_tag: string | null;
  is_active: number;
  provider?: string | null;
  institution_name?: string | null;
  teller_enrollment_id?: string | null;
  plaid_account_id?: string | null;
  teller_account_id?: string | null;
  created_at: string;
}

export interface AccountListResponse {
  accounts: Account[];
}

export interface BankConfig {
  current_provider: "teller" | "plaid";
  application_id?: string;
  environment?: string;
  products?: string[];
  select_account?: string;
  link_token?: string;
  [k: string]: unknown;
}

// ── Tax year workflow ───────────────────────────────────────────────────

export interface TaxYearWorkflow {
  workflow: {
    id: string;
    tax_year: number;
    started_at: string;
    completed_at: string | null;
  } | null;
  checklist?: Array<{
    id: string;
    item_key: string;
    label: string;
    status: "pending" | "in_progress" | "complete";
    account_id: string | null;
    account_name: string | null;
  }>;
  recommended_tax_year?: number;
}

// ── Transactions ────────────────────────────────────────────────────────

export interface Transaction {
  id: string;
  user_id: string;
  account_id: string | null;
  posted_date: string;
  amount: number;
  currency: string;
  merchant_name: string | null;
  description: string;
  is_pending: number;
  account_name?: string | null;
  account_owner?: string | null;
  classification?: {
    entity: string | null;
    category_tax: string | null;
    category_budget: string | null;
    confidence: number | null;
    method: string | null;
    review_required: number;
  } | null;
}

export interface TransactionListResponse {
  transactions: Transaction[];
  total: number;
  limit: number;
  offset: number;
}
