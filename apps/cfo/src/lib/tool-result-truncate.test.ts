import { describe, it, expect } from "vitest";
import { truncateForChat, drillInFor } from "./tool-result-truncate";

// Helpers for tests — keep maxBytes small enough that toy payloads
// reliably trip truncation, but big enough that the JSON-aware
// truncation path can fit the truncated payload + the _truncated
// marker. 500 bytes is the sweet spot.
const tinyOpts = { maxBytes: 500, maxItemsPerArray: 3 } as const;
const drillOpts = { ...tinyOpts, drillInHint: "/#/transactions" } as const;

describe("truncateForChat", () => {
  it("passes small text through unchanged", () => {
    const out = truncateForChat('{"hello":"world"}', tinyOpts);
    expect(out).toBe('{"hello":"world"}');
  });

  it("truncates a large top-level array to maxItemsPerArray + a marker", () => {
    const big = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ id: `tx_${i}`, amount: i, pad: "x".repeat(30) })),
    );
    const out = truncateForChat(big, tinyOpts);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    // 3 real items + 1 _truncated marker
    expect(parsed.length).toBe(4);
    expect(parsed[0]).toMatchObject({ id: "tx_0", amount: 0 });
    expect(parsed[3]).toHaveProperty("_truncated");
    expect(String(parsed[3]._truncated)).toMatch(/47 more items omitted/);
  });

  it("truncates nested arrays inside an object", () => {
    // Pad each item so the serialized payload exceeds tinyOpts.maxBytes (200).
    const big = JSON.stringify({
      total: 100,
      items: Array.from({ length: 25 }, (_, i) => ({ i, pad: "x".repeat(20) })),
      meta: { ok: true },
    });
    const out = truncateForChat(big, tinyOpts);
    const parsed = JSON.parse(out);
    expect(parsed.total).toBe(100);          // scalar preserved
    expect(parsed.meta).toEqual({ ok: true });
    expect(parsed.items.length).toBe(4);     // 3 + marker
    expect(parsed.items[3]).toHaveProperty("_truncated");
  });

  it("includes the drill-in hint in the truncation marker", () => {
    const big = JSON.stringify({
      items: Array.from({ length: 25 }, (_, i) => ({ i, pad: "x".repeat(30) })),
    });
    const out = truncateForChat(big, drillOpts);
    expect(out).toContain("/#/transactions");
  });

  it("falls back to byte-cap when JSON.parse fails", () => {
    const big = "x".repeat(5000); // not valid JSON, larger than maxBytes
    const out = truncateForChat(big, tinyOpts);
    expect(out.length).toBeLessThanOrEqual(tinyOpts.maxBytes);
    expect(out).toMatch(/Truncated at \d+ bytes/);
    expect(out).toMatch(/\d+ more bytes omitted/);
  });

  it("byte-cap includes the drill-in hint", () => {
    const big = "x".repeat(5000);
    const out = truncateForChat(big, drillOpts);
    expect(out).toContain("/#/transactions");
  });

  it("falls back to byte-cap when array truncation alone isn't enough", () => {
    // Each item large enough that even 3 items + a marker overflow maxBytes (500).
    const huge = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ payload: "x".repeat(1000), i })),
    );
    const out = truncateForChat(huge, tinyOpts);
    // Byte-cap branch trails a non-JSON marker; must be ≤ maxBytes and
    // surface a "Truncated" note.
    expect(out.length).toBeLessThanOrEqual(tinyOpts.maxBytes);
    expect(out).toMatch(/Truncated at \d+ bytes/);
  });

  it("preserves a small object verbatim even when the cap is small", () => {
    const small = JSON.stringify({ ok: true, n: 1 });
    expect(truncateForChat(small, tinyOpts)).toBe(small);
  });

  it("default maxBytes is 8000 — a 9KB string gets capped without opts", () => {
    const big = "x".repeat(9000);
    const out = truncateForChat(big);
    // Default cap (8000) exceeded → byte-cap kicks in. Output should
    // not exceed 8000 bytes, and surface the truncation marker.
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out).toMatch(/Truncated at 8000 bytes/);
  });

  it("handles deeply nested arrays", () => {
    const padded = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ slug: `${prefix}_${i}`, pad: "x".repeat(20) }));
    const nested = JSON.stringify({
      year: 2025,
      reports: {
        income:   { categories: padded("inc", 15) },
        expenses: { categories: padded("exp", 15) },
      },
    });
    const out = truncateForChat(nested, tinyOpts);
    const parsed = JSON.parse(out);
    expect(parsed.reports.income.categories.length).toBe(4);
    expect(parsed.reports.expenses.categories.length).toBe(4);
    expect(parsed.year).toBe(2025);
  });

  it("singular '1 more item omitted' (no plural-s)", () => {
    // 4 items, padded so the source exceeds tinyOpts.maxBytes (500)
    // but 3-items-after-truncation still fit within 500.
    const big = JSON.stringify(
      Array.from({ length: 4 }, (_, i) => ({ i, pad: "x".repeat(110) })),
    );
    const out = truncateForChat(big, tinyOpts);
    const parsed = JSON.parse(out);
    expect(parsed[3]._truncated).toMatch(/1 more item omitted/);
    expect(parsed[3]._truncated).not.toMatch(/items omitted/);
  });
});

describe("drillInFor", () => {
  it("maps known tools to their SPA hash routes", () => {
    expect(drillInFor("list_review_queue")).toBe("/#/review");
    expect(drillInFor("transactions_summary")).toBe("/#/transactions");
    expect(drillInFor("budget_status")).toBe("/#/budget");
  });

  it("returns undefined for unknown tools", () => {
    expect(drillInFor("never_heard_of_this")).toBeUndefined();
  });
});
