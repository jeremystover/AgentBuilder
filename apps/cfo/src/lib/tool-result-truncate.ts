/**
 * Cap chat-bound tool results so a single Claude turn never blows the
 * context budget. The web chat exposes 10 tools that can return large
 * payloads — `transactions_summary` over a full tax year, a 200-row
 * review queue, a Schedule C with hundreds of line items. Without a
 * cap, asking "show me everything" silently 500s once we cross the
 * model's per-turn limit.
 *
 * Strategy:
 *   1. If the text is small, pass it through.
 *   2. Try to parse as JSON. If it has arrays at any depth, truncate
 *      each to N items and append a `_truncated` marker telling the
 *      model how many it dropped + how to drill in via the SPA.
 *   3. If it's still too big after array truncation OR isn't valid
 *      JSON, byte-cap with a "open the SPA for the full result" note.
 *
 * This is intentionally surface-only — the worker's REST routes still
 * return full payloads. The cap only applies to the web chat (where
 * the model consumes results); MCP, the SPA, and direct REST calls
 * see everything.
 */

export interface TruncateOptions {
  /** Soft byte ceiling for the returned text. Defaults to 8000 (~2k tokens). */
  maxBytes?: number;
  /** Per-array item cap when JSON-aware truncation kicks in. Defaults to 10. */
  maxItemsPerArray?: number;
  /** Where the user can drill into the full data (e.g. "/#/transactions"). */
  drillInHint?: string;
}

const DEFAULT_MAX_BYTES = 8000;
const DEFAULT_MAX_ITEMS = 10;

export function truncateForChat(text: string, opts: TruncateOptions = {}): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxItems = opts.maxItemsPerArray ?? DEFAULT_MAX_ITEMS;
  const hint = opts.drillInHint;

  if (text.length <= maxBytes) return text;

  // Try JSON-aware truncation first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return byteCap(text, maxBytes, hint);
  }

  // Compact (no indent) so the truncation note has room to fit. The
  // model parses this — pretty-printing would just waste tokens.
  const truncated = truncateArrays(parsed, maxItems, hint);
  const truncatedStr = JSON.stringify(truncated);
  if (truncatedStr.length <= maxBytes) return truncatedStr;

  // Even after array truncation we're over — fall back to byte cap.
  return byteCap(truncatedStr, maxBytes, hint);
}

function byteCap(text: string, maxBytes: number, hint: string | undefined): string {
  // Reserve ~120 bytes for the trailing note so we don't blow the cap.
  const sliceLen = Math.max(0, maxBytes - 200);
  const head = text.slice(0, sliceLen);
  const tail = `\n\n[Truncated at ${maxBytes} bytes — ${text.length - sliceLen} more bytes omitted.${
    hint ? ` Open ${hint} for the full result.` : ""
  }]`;
  return head + tail;
}

function truncateArrays(value: unknown, maxItems: number, hint: string | undefined): unknown {
  if (Array.isArray(value)) {
    if (value.length > maxItems) {
      const kept = value.slice(0, maxItems).map((v) => truncateArrays(v, maxItems, hint));
      const dropped = value.length - maxItems;
      return [
        ...kept,
        {
          _truncated: `${dropped} more item${dropped !== 1 ? "s" : ""} omitted.${
            hint ? ` Open ${hint} for the full list.` : ""
          }`,
        },
      ];
    }
    return value.map((v) => truncateArrays(v, maxItems, hint));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateArrays(v, maxItems, hint);
    }
    return out;
  }
  return value;
}

// ── Per-tool drill-in hints (SPA hash routes) ─────────────────────────────
// Surfaced in truncation notes so the model can tell the user where to
// click for the full data. These mirror the routes in src/web/router.ts.

export const TOOL_DRILL_IN_HINTS: Record<string, string> = {
  list_review_queue:        "/#/review",
  next_review_item:         "/#/review",
  transactions_summary:     "/#/transactions",
  pnl_all_entities:         "/#/reports",
  budget_status:            "/#/budget",
  schedule_c_report:        "/#/reports",
  start_bookkeeping_session: "/#/transactions",
  get_bookkeeping_batch:    "/#/transactions",
};

export function drillInFor(toolName: string): string | undefined {
  return TOOL_DRILL_IN_HINTS[toolName];
}
