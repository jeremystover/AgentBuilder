import { describe, it, expect } from "vitest";
import { summarizeToolResult } from "./tool-summarize";

const j = (v: unknown) => JSON.stringify(v);

describe("summarizeToolResult — per-tool extractors", () => {
  it("list_review_queue: total wins, items.length is fallback", () => {
    expect(summarizeToolResult("list_review_queue", j({ total: 12, items: [{}, {}] })))
      .toBe("12 pending");
    expect(summarizeToolResult("list_review_queue", j({ items: [{}, {}, {}] })))
      .toBe("3 pending");
  });

  it("next_review_item: merchant + suggested category", () => {
    expect(summarizeToolResult("next_review_item", j({
      merchant_name: "Lyft", suggested_category_tax: "auto_travel",
    }))).toBe("Lyft → auto travel");
  });

  it("next_review_item: empty=true says queue empty", () => {
    expect(summarizeToolResult("next_review_item", j({ empty: true })))
      .toBe("queue empty");
  });

  it("pnl_all_entities: period label + net", () => {
    expect(summarizeToolResult("pnl_all_entities", j({
      period: { label: "April 2026" },
      consolidated: { net_income: 2100 },
    }))).toBe("April 2026 · net $2,100");
  });

  it("pnl_all_entities: negative net renders correctly", () => {
    expect(summarizeToolResult("pnl_all_entities", j({
      period: { label: "March 2026" },
      consolidated: { net_income: -842.5 },
    }))).toBe("March 2026 · net -$842.50");
  });

  it("budget_status: counts over + near", () => {
    const out = summarizeToolResult("budget_status", j({
      period: { label: "April" },
      categories: [
        { status: "over" }, { status: "near" }, { status: "under" },
      ],
    }));
    expect(out).toBe("April: 1 over budget, 1 near");
  });

  it("budget_status: all under = 'on track'", () => {
    expect(summarizeToolResult("budget_status", j({
      categories: [{ status: "under" }, { status: "under" }],
    }))).toBe("2 on track");
  });

  it("schedule_c_report: net profit + pending", () => {
    expect(summarizeToolResult("schedule_c_report", j({
      tax_year: "2025", net_profit: 46010, pending_review: 3,
    }))).toBe("2025 · net $46,010, 3 pending");
  });

  it("classify_transactions: total + review_required", () => {
    expect(summarizeToolResult("classify_transactions", j({
      total: 12, rules: 4, ai: 6, review_required: 2,
    }))).toBe("12 classified, 2 to review");
  });

  it("transactions_summary: tax year + entity count + income total", () => {
    const out = summarizeToolResult("transactions_summary", j({
      tax_year: "2025",
      by_entity: [
        { entity: "elyse_coaching", total: 48230 },
        { entity: "family_personal", total: -23410 },
      ],
    }));
    expect(out).toBe("2025 · 2 entities, $48,230 in");
  });

  it("start_bookkeeping_session: entity + total counts", () => {
    expect(summarizeToolResult("start_bookkeeping_session", j({
      entity: "elyse_coaching",
      counts: { unclassified: 8, low_confidence: 3, review: 0 },
    }))).toBe("elyse coaching · 11 items");
  });

  it("get_bookkeeping_batch: phase + items + (more) when paginated", () => {
    expect(summarizeToolResult("get_bookkeeping_batch", j({
      phase: "unclassified", items: [{}, {}, {}], next_offset: 50,
    }))).toBe("unclassified: 3 items (more)");
    expect(summarizeToolResult("get_bookkeeping_batch", j({
      phase: "review", items: [], next_offset: null,
    }))).toBe("review: 0 items");
  });

  it("resolve_review: ok vs error", () => {
    expect(summarizeToolResult("resolve_review", j({ ok: true }))).toBe("saved");
  });
});

describe("summarizeToolResult — error + fallback paths", () => {
  it("surfaces tool errors plainly", () => {
    expect(summarizeToolResult("list_review_queue", j({ error: "Transaction not found" })))
      .toMatch(/error: Transaction not found/);
  });

  it("truncates very long error messages", () => {
    const longErr = "x".repeat(200);
    const out = summarizeToolResult("list_review_queue", j({ error: longErr }));
    expect(out).toMatch(/^error: x{80}$/);
  });

  it("returns null for an unknown tool with empty payload", () => {
    expect(summarizeToolResult("never_heard_of_this", j({}))).toBeNull();
  });

  it("falls back to '(N items)' for unknown tool with array payload", () => {
    expect(summarizeToolResult("never_heard_of_this", j([1, 2, 3, 4])))
      .toBe("4 items");
  });

  it("falls back to '(N items)' for unknown tool with array under a key", () => {
    expect(summarizeToolResult("never_heard_of_this", j({ rows: [1, 2, 3, 4, 5] })))
      .toBe("5 items");
  });

  it("byte-capped (non-JSON) result returns the first 60 chars compacted", () => {
    const truncated =
      "[{\"id\":\"tx_1\",\"merchant_name\":\"Long Merchant Name\",\"amount\":-12.50},{\"id\"\n\n[Truncated at 8000 bytes]";
    const out = summarizeToolResult("list_review_queue", truncated);
    expect(out).toBeTruthy();
    expect(out!.length).toBeLessThanOrEqual(61); // 60 + ellipsis
  });

  it("never throws on a malformed payload", () => {
    expect(() => summarizeToolResult("list_review_queue", "not json {[")).not.toThrow();
  });
});
