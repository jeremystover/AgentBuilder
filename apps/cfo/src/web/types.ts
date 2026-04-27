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

// ── Notes + tasks (AI-5) ─────────────────────────────────────────────────

export type NoteKind = "note" | "task";
export type NoteStatus = "open" | "done";

export interface Note {
  id: string;
  user_id: string;
  kind: NoteKind;
  title: string;
  body: string;
  status: NoteStatus;
  tax_year: number | null;
  source_chat_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateNoteInput {
  kind: NoteKind;
  title: string;
  body?: string;
  tax_year?: number;
  source_chat_message_id?: string;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  status?: NoteStatus;
  tax_year?: number | null;
}
