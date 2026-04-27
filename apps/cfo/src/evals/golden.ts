/**
 * Golden-set Q&A definitions for the web-chat tool surface.
 *
 * Each case asserts:
 *   - which tools the model SHOULD call (or shouldn't)
 *   - a few content tokens the reply MUST contain
 *
 * These run against the live Anthropic API via runner.ts; the goal is
 * to catch regressions when the system prompt or tool descriptions
 * change. Add a case here every time you fix a class of failure.
 */

export interface GoldenCase {
  /** Stable id for snapshot diffs and disable-by-id during triage. */
  id: string;
  /** Free-form description for human readers. */
  why: string;
  /** Single user message. History is empty per case for determinism. */
  user: string;
  expects: {
    /** Tools the model MUST call (any order). */
    called?: string[];
    /** Tools the model MUST NOT call (e.g., mutations on a read-only Q). */
    not_called?: string[];
    /** Tool group: at least one of these must be called. */
    called_any_of?: string[];
    /** Substring(s) the final reply must contain (case-insensitive). */
    mentions?: string[];
    /** Substrings the final reply must NOT contain. */
    forbidden?: string[];
    /** Hard cap on iterations — guards against runaway tool loops. */
    max_iterations?: number;
  };
}

export const GOLDEN_CASES: GoldenCase[] = [
  {
    id: "review_queue_attention",
    why: "List-review-queue is the answer for any 'what needs my attention' question.",
    user: "What needs my attention right now?",
    expects: {
      called: ["list_review_queue"],
      not_called: ["resolve_review", "classify_transactions"],
    },
  },
  {
    id: "monthly_pnl",
    why: "P&L questions go through pnl_all_entities, not schedule_c_report.",
    user: "How did we do last month?",
    expects: {
      called: ["pnl_all_entities"],
      mentions: ["$"],
    },
  },
  {
    id: "budget_specific_category",
    why: "Budget status takes a category filter; don't hand off to PnL.",
    user: "Are we over on travel this month?",
    expects: {
      called: ["budget_status"],
      mentions: ["travel"],
      not_called: ["pnl_all_entities"],
    },
  },
  {
    id: "schedule_c_for_year",
    why: "Schedule C report should map to schedule_c_report, not generic summary.",
    user: "What does my Schedule C look like for last year?",
    expects: {
      called: ["schedule_c_report"],
    },
  },
  {
    id: "concept_only_no_tool",
    why: "Pure tax/accounting knowledge questions should NOT touch tools.",
    user: "What's the meal-deduction limit on Schedule C line 24b?",
    expects: {
      not_called: [
        "list_review_queue", "next_review_item", "resolve_review",
        "transactions_summary", "pnl_all_entities", "budget_status",
        "schedule_c_report", "classify_transactions",
        "start_bookkeeping_session", "get_bookkeeping_batch",
      ],
      mentions: ["50", "%"],
    },
  },
  {
    id: "redirect_imports_to_legacy",
    why: "Import flows live in the SPA only — chat should redirect, not call a tool.",
    user: "Can you import this CSV file for me?",
    expects: {
      not_called: ["classify_transactions", "resolve_review"],
      mentions: ["imports"],
    },
  },
  {
    id: "no_invented_numbers_on_empty",
    why: "When the model has no data it should say so plainly, not fabricate.",
    user: "How much did I spend on coffee this year?",
    expects: {
      called_any_of: ["transactions_summary", "list_review_queue", "pnl_all_entities"],
      forbidden: ["i estimate", "approximately $"],
    },
  },
  {
    id: "review_drill_in_flow",
    why: "Walk-me-through-categorization should pull next_review_item, not list+iterate.",
    user: "Walk me through the next few things in the review queue.",
    expects: {
      called_any_of: ["next_review_item", "list_review_queue"],
    },
  },
  {
    id: "bookkeeping_session_for_entity",
    why: "Entity-specific bookkeeping triggers start_bookkeeping_session.",
    user: "Walk me through the books for Elyse coaching.",
    expects: {
      called: ["start_bookkeeping_session"],
    },
  },
  {
    id: "do_not_resolve_without_explicit_ask",
    why: "resolve_review writes — model must NOT call it unprompted.",
    user: "Show me what's in the review queue.",
    expects: {
      called: ["list_review_queue"],
      not_called: ["resolve_review"],
    },
  },

  // ── Multi-tool chains (AI-2) ────────────────────────────────────────────
  {
    id: "chain_monthly_debrief",
    why: "A monthly debrief asks for P&L + budget + queue in one breath; the model should chain all three before replying.",
    user: "Give me a quick monthly debrief — how are we doing and what's off-track?",
    expects: {
      called: ["pnl_all_entities", "budget_status"],
      called_any_of: ["list_review_queue"],
      not_called: ["resolve_review", "classify_transactions"],
      max_iterations: 6,
    },
  },
  {
    id: "chain_pnl_plus_anomalies",
    why: "P&L + 'what should I worry about' should pull both pnl_all_entities AND list_review_queue, then synthesize.",
    user: "How are we doing this month, and what should I worry about?",
    expects: {
      called: ["pnl_all_entities"],
      called_any_of: ["list_review_queue", "budget_status"],
      max_iterations: 5,
    },
  },
  {
    id: "chain_tax_prep_status",
    why: "Tax-prep status pulls schedule_c_report + the review queue.",
    user: "Where are we on tax prep — what's done and what's left?",
    expects: {
      called: ["schedule_c_report"],
      called_any_of: ["list_review_queue"],
      max_iterations: 6,
    },
  },
  {
    id: "no_extra_tools_when_one_answers",
    why: "Don't call extra tools when one already gives the answer — single-question = single-tool.",
    user: "How much did we spend on travel in March?",
    expects: {
      called_any_of: ["budget_status", "transactions_summary"],
      max_iterations: 3,  // a chain here would waste latency
    },
  },
];
