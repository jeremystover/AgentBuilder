// One-line summary of a tool's JSON result, surfaced inline next to
// the tool pill in the chat UI so the user sees "list_review_queue ·
// 12 pending" the moment the tool returns — not after the model has
// finished its reply.
//
// Per-tool extractors pick the 1-2 most useful fields from each tool's
// known shape; a generic fallback handles unrecognized payloads (count
// of items in known array fields, or "ok" for small objects).

type Summarizer = (parsed: unknown) => string | null;

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const opts: Intl.NumberFormatOptions = abs >= 1000
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `${sign}$${abs.toLocaleString(undefined, opts)}`;
}

const PER_TOOL: Record<string, Summarizer> = {
  list_review_queue(p) {
    const r = p as { items?: unknown[]; total?: number };
    if (typeof r.total === "number") return `${r.total} pending`;
    if (Array.isArray(r.items)) return `${r.items.length} pending`;
    return null;
  },

  next_review_item(p) {
    const r = p as {
      empty?: boolean;
      merchant_name?: string;
      suggested_category_tax?: string;
    };
    if (r.empty) return "queue empty";
    const merchant = r.merchant_name ?? "(unknown)";
    if (r.suggested_category_tax) {
      return `${merchant} → ${r.suggested_category_tax.replace(/_/g, " ")}`;
    }
    return merchant;
  },

  resolve_review(p) {
    const r = p as { ok?: boolean; error?: string };
    if (r.error) return `error: ${r.error}`;
    if (r.ok) return "saved";
    return null;
  },

  transactions_summary(p) {
    const r = p as {
      tax_year?: string;
      by_entity?: Array<{ entity: string; total: number }>;
    };
    if (!r.by_entity?.length) return r.tax_year ? `${r.tax_year}, no data` : null;
    const totalIncome = r.by_entity.filter((e) => e.total > 0).reduce((s, e) => s + e.total, 0);
    return `${r.tax_year ?? ""} · ${r.by_entity.length} entities, ${fmtUsd(totalIncome)} in`.trim();
  },

  pnl_all_entities(p) {
    const r = p as {
      period?: { label?: string };
      consolidated?: { net_income?: number; income?: number };
    };
    const label = r.period?.label ? `${r.period.label} · ` : "";
    if (r.consolidated && typeof r.consolidated.net_income === "number") {
      return `${label}net ${fmtUsd(r.consolidated.net_income)}`;
    }
    return null;
  },

  budget_status(p) {
    const r = p as {
      period?: { label?: string };
      categories?: Array<{ status?: string }>;
    };
    if (!r.categories?.length) return "no targets set";
    const over = r.categories.filter((c) => c.status === "over").length;
    const near = r.categories.filter((c) => c.status === "near").length;
    const label = r.period?.label ? `${r.period.label}: ` : "";
    if (over > 0) return `${label}${over} over budget${near > 0 ? `, ${near} near` : ""}`;
    if (near > 0) return `${label}${near} near limit`;
    return `${label}${r.categories.length} on track`;
  },

  schedule_c_report(p) {
    const r = p as {
      tax_year?: string;
      net_profit?: number;
      pending_review?: number;
    };
    const yr = r.tax_year ? `${r.tax_year} · ` : "";
    const profit = typeof r.net_profit === "number" ? `net ${fmtUsd(r.net_profit)}` : null;
    const pending = r.pending_review ? `${r.pending_review} pending` : null;
    return [yr + (profit ?? ""), pending].filter(Boolean).join(", ").trim() || null;
  },

  classify_transactions(p) {
    const r = p as {
      total?: number;
      rules?: number;
      ai?: number;
      review_required?: number;
    };
    if (typeof r.total !== "number") return null;
    const parts = [`${r.total} classified`];
    if (r.review_required) parts.push(`${r.review_required} to review`);
    return parts.join(", ");
  },

  start_bookkeeping_session(p) {
    const r = p as {
      entity?: string;
      counts?: Record<string, number>;
    };
    const ent = r.entity?.replace(/_/g, " ") ?? "";
    if (!r.counts) return ent || null;
    const total = Object.values(r.counts).reduce((s, n) => s + (n ?? 0), 0);
    return `${ent} · ${total} items`.trim();
  },

  get_bookkeeping_batch(p) {
    const r = p as {
      entity?: string;
      phase?: string;
      items?: unknown[];
      next_offset?: number | null;
    };
    const items = r.items?.length ?? 0;
    const tail = r.next_offset != null ? " (more)" : "";
    return `${r.phase ?? "batch"}: ${items} items${tail}`.trim();
  },
};

/**
 * Public entry point. content is the raw JSON-stringified tool result
 * (already truncated to <=8 KB by AI-3's truncateForChat). Returns a
 * one-line summary, or null if nothing useful can be extracted.
 *
 * Never throws — a malformed payload just returns null and the pill
 * shows the bare tool name.
 */
export function summarizeToolResult(toolName: string, content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // The truncator may have left a non-JSON byte-cap tail. Grab the
    // first 60 chars of meaningful text as a last resort.
    const compact = content.replace(/\s+/g, " ").trim();
    return compact.length > 60 ? `${compact.slice(0, 60)}…` : compact || null;
  }

  // Tool returned an explicit error (handled by web-chat-tools.ts on a
  // throw). Surface it so the user sees "tool errored" not just "ok".
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const err = String((parsed as { error: unknown }).error ?? "");
    return err ? `error: ${err.slice(0, 80)}` : "error";
  }

  const fn = PER_TOOL[toolName];
  if (fn) {
    const out = fn(parsed);
    if (out) return out;
  }

  return genericFallback(parsed);
}

function genericFallback(parsed: unknown): string | null {
  if (parsed == null) return null;
  if (Array.isArray(parsed)) return `${parsed.length} items`;
  if (typeof parsed === "object") {
    // Look for any obvious top-level array.
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) return `${v.length} items`;
    }
    return null;
  }
  if (typeof parsed === "string") return parsed.slice(0, 60);
  return String(parsed);
}
