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
