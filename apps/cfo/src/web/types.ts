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

// ── Accounts ─────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  name: string;
  type: string;
  subtype: string | null;
  mask: string | null;
  owner_tag: EntitySlug | null;
  is_active: number;
  institution_name: string | null;
  provider: "teller" | "plaid" | "manual";
  teller_account_id: string | null;
  teller_enrollment_id: string | null;
  created_at: string;
}

export interface BankConfig {
  default_provider: string;
  available_providers: string[];
  providers: {
    teller: {
      configured: boolean;
      environment: string;
      sandbox_shortcut: boolean;
    };
  };
}

export interface Snapshot {
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

// ── Transactions ─────────────────────────────────────────────────────────

export type EntitySlug = "elyse_coaching" | "jeremy_coaching" | "airbnb_activity" | "family_personal";

export interface Transaction {
  id: string;
  user_id: string;
  account_id: string;
  posted_date: string;
  amount: number;
  currency: string | null;
  merchant_name: string | null;
  description: string | null;
  import_id: string | null;
  // Joined from classifications
  entity: EntitySlug | null;
  category_tax: string | null;
  category_budget: string | null;
  confidence: number | null;
  method: string | null;
  reason_codes: string | null;
  review_required: number | null;
  is_locked: number | null;
  // Joined from accounts
  account_name: string | null;
  owner_tag: string | null;
  account_type: string | null;
}

export interface TransactionSplit {
  id: string;
  transaction_id: string;
  entity: EntitySlug;
  category_tax: string | null;
  amount: number;
  note: string | null;
}

export interface ClassificationHistoryEntry {
  id: string;
  transaction_id: string;
  entity: EntitySlug | null;
  category_tax: string | null;
  category_budget: string | null;
  confidence: number | null;
  method: string | null;
  reason_codes: string | null;
  changed_at: string;
  changed_by: string | null;
}

export interface TransactionAttachment {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  note: string | null;
  created_at: string;
}

export interface AmazonMatch {
  order_id: string;
  order_date: string | null;
  shipment_date: string | null;
  total_amount: number | null;
  product_names: string | null;
  seller_names: string | null;
  ship_to: string | null;
  shipping_address: string | null;
  match_score: number | null;
  match_method: string | null;
}

export interface TransactionDetail {
  transaction: Transaction;
  splits: TransactionSplit[];
  history: ClassificationHistoryEntry[];
  attachments: TransactionAttachment[];
  amazon_matches: AmazonMatch[];
}

export interface TransactionListResponse {
  transactions: Transaction[];
  total: number;
  limit: number;
  offset: number;
}

// ── Imports ──────────────────────────────────────────────────────────────

export type ImportSource = "plaid" | "teller" | "csv" | "manual" | "amazon";
export type ImportStatus = "pending" | "running" | "completed" | "failed";

export interface ImportRecord {
  id: string;
  user_id: string;
  source: ImportSource;
  account_id: string | null;
  status: ImportStatus;
  date_from: string | null;
  date_to: string | null;
  transactions_found: number;
  transactions_imported: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  account_name: string | null;
}

export interface CsvImportResult {
  import_id: string;
  format: string;
  rows_parsed: number;
  transactions_imported: number;
  duplicates_skipped: number;
  errors: string[];
  message: string;
}

export interface AmazonImportResult {
  import_id: string;
  rows_parsed: number;
  amazon_orders_imported: number;
  rows_skipped: number;
  transactions_matched: number;
  transactions_unmatched: number;
  transactions_reclassified: number;
  message: string;
}

export interface TillerImportResult {
  import_id: string;
  total_rows: number;
  transactions_imported: number;
  duplicates_skipped: number;
  non_transaction_skipped: number;
  unmapped_categories: string[];
  learned_rules_created: number;
  ambiguous_rule_groups_skipped: number;
  message: string;
}

export interface DeleteImportsResult {
  transactions_deleted: number;
  imports_deleted?: number;
  import_deleted?: boolean;
  locked_transactions_skipped: number;
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
  entity: EntitySlug;
  category_tax: string | null;
  category_budget: string | null;
  priority: number;
  is_active: number;
  created_at: string;
}

export interface AutoCatImportResult {
  total_rows: number;
  rules_created: number;
  skipped: number;
  skipped_transfers: number;
  warnings: string[];
  message: string;
}

// ── Budget ───────────────────────────────────────────────────────────────

export type BudgetCadence = "weekly" | "monthly" | "annual";
export type BudgetPreset =
  | "this_week" | "this_month" | "last_month"
  | "ytd" | "trailing_30d" | "trailing_90d";
export type BudgetStatusTone = "no_target" | "over" | "near" | "under";

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
  cadence: BudgetCadence;
  amount: number;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  category_name: string | null;
}

export interface BudgetStatusLine {
  category_slug: string;
  category_name: string;
  target: {
    native_amount: number;
    native_cadence: BudgetCadence;
    prorated_amount: number;
  } | null;
  spent: number;
  tx_count: number;
  remaining: number | null;
  percent_used: number | null;
  status: BudgetStatusTone;
}

export interface BudgetStatusResponse {
  period: { start: string; end: string; days: number; label: string };
  categories: BudgetStatusLine[];
}

// ── Reports ──────────────────────────────────────────────────────────────

export type ScheduleCEntity = "elyse_coaching" | "jeremy_coaching";
export type ScheduleKind = "C" | "E";

export interface ScheduleLine {
  category_tax: string;
  category_name: string | null;
  form_line: string | null;
  total_amount: number;
  transaction_count: number;
}

export interface ScheduleReport {
  tax_year: string;
  entity: EntitySlug;
  schedule: ScheduleKind;
  income: { categories: ScheduleLine[]; total: number };
  expenses: { categories: ScheduleLine[]; total: number };
  net_profit: number;
  pending_review: number;
}

export interface SummaryEntityRow {
  entity: EntitySlug | null;
  total: number;
  count: number;
}

export interface SummaryMonthRow {
  month: string;
  entity: EntitySlug | null;
  total: number;
}

export interface SummaryReviewRow {
  status: ReviewStatus;
  count: number;
}

export interface SummaryReport {
  tax_year: string;
  by_entity: SummaryEntityRow[];
  by_month: SummaryMonthRow[];
  review_queue: SummaryReviewRow[];
}

// ── Income ───────────────────────────────────────────────────────────────

export type IncomeStatusTone = "no_target" | "under" | "near" | "on_track";

export interface IncomeTarget {
  id: string;
  entity: EntitySlug;
  cadence: BudgetCadence;
  amount: number;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  created_at: string;
}

export interface IncomeStatusLine {
  entity: EntitySlug;
  target: {
    native_amount: number;
    native_cadence: BudgetCadence;
    prorated_amount: number;
  } | null;
  actual_income: number;
  actual_expense: number;
  net: number;
  pct_of_target: number | null;
  status: IncomeStatusTone;
  tx_count_income: number;
  tx_count_expense: number;
}

export interface IncomeStatusResponse {
  period: { start: string; end: string; days: number; label: string };
  entities: IncomeStatusLine[];
}
