/**
 * Cap chat-bound tool results so a single Claude turn never blows the
 * context budget. Approach:
 *   1. If the text is small, pass it through.
 *   2. Try to parse as JSON. If it has arrays at any depth, truncate
 *      each to N items and append a `_truncated` marker telling the
 *      model how many it dropped + how to drill in via the SPA.
 *   3. If it's still too big after array truncation OR isn't valid
 *      JSON, byte-cap with a "open the SPA for the full result" note.
 *
 * Surface-only — REST routes always return full payloads. The cap only
 * applies to in-app chat results (where the model consumes them).
 */

export interface TruncateOptions {
  /** Soft byte ceiling for the returned text. Defaults to 8000 (~2k tokens). */
  maxBytes?: number;
  /** Per-array item cap when JSON-aware truncation kicks in. Defaults to 10. */
  maxItemsPerArray?: number;
  /** Where the user can drill into the full data (e.g. "/#/review"). */
  drillInHint?: string;
}

const DEFAULT_MAX_BYTES = 8000;
const DEFAULT_MAX_ITEMS = 10;

export function truncateForChat(text: string, opts: TruncateOptions = {}): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxItems = opts.maxItemsPerArray ?? DEFAULT_MAX_ITEMS;
  const hint = opts.drillInHint;

  if (text.length <= maxBytes) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return byteCap(text, maxBytes, hint);
  }

  const truncated = truncateArrays(parsed, maxItems, hint);
  const truncatedStr = JSON.stringify(truncated);
  if (truncatedStr.length <= maxBytes) return truncatedStr;
  return byteCap(truncatedStr, maxBytes, hint);
}

function byteCap(text: string, maxBytes: number, hint: string | undefined): string {
  const sliceLen = Math.max(0, maxBytes - 200);
  const head = text.slice(0, sliceLen);
  const tail = `\n\n[Truncated at ${maxBytes} bytes — ${text.length - sliceLen} more bytes omitted.${
    hint ? ` Open ${hint} for the full result.` : ''
  }]`;
  return head + tail;
}

function truncateArrays(value: unknown, maxItems: number, hint: string | undefined): unknown {
  if (Array.isArray(value)) {
    if (value.length > maxItems) {
      const kept = value.slice(0, maxItems).map(v => truncateArrays(v, maxItems, hint));
      const dropped = value.length - maxItems;
      return [
        ...kept,
        {
          _truncated: `${dropped} more item${dropped !== 1 ? 's' : ''} omitted.${
            hint ? ` Open ${hint} for the full list.` : ''
          }`,
        },
      ];
    }
    return value.map(v => truncateArrays(v, maxItems, hint));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateArrays(v, maxItems, hint);
    }
    return out;
  }
  return value;
}

export const TOOL_DRILL_IN_HINTS: Record<string, string> = {
  review_next:          '/#/review',
  review_resolve:       '/#/review',
  review_bulk_accept:   '/#/review',
  review_status:        '/#/review',
  transactions_list:    '/#/transactions',
  spending_summary:     '/#/spending',
  plan_forecast:        '/#/planning',
  plan_list:            '/#/planning',
  rules_list:           '/#/review',
  rules_create:         '/#/review',
  accounts_list:        '/#/gather',
  sync_run:             '/#/gather',
  report_list_configs:  '/#/reporting',
  report_generate:      '/#/reporting',
};

export function drillInFor(toolName: string): string | undefined {
  return TOOL_DRILL_IN_HINTS[toolName];
}
