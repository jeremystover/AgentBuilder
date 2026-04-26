/**
 * Structural sanity checks for the chat tool surface. Always run (no
 * Anthropic API needed) — catches the kind of mistakes that "would
 * have been caught by even glancing at the test suite":
 *
 *   - TOOL_ALLOWLIST drifts from MCP_TOOLS
 *   - Drill-in hint added but the tool name is wrong
 *   - SYSTEM_PROMPT loses required guidance during a refactor
 *   - GOLDEN_CASES reference unknown tools
 *
 * The vitest harness here also hosts AI-1's live evals (golden.test.ts);
 * structural checks are the always-on floor under that.
 */

import { describe, it, expect } from "vitest";
import { MCP_TOOLS } from "../mcp-tools";
import { TOOL_ALLOWLIST } from "../web-chat-tools";
import { TOOL_DRILL_IN_HINTS } from "../lib/tool-result-truncate";
import { SYSTEM_PROMPT } from "../web-chat";
import { GOLDEN_CASES } from "./golden";

describe("TOOL_ALLOWLIST", () => {
  it("is non-empty and ≤ 10 entries (AGENTS.md rule 2)", () => {
    expect(TOOL_ALLOWLIST.length).toBeGreaterThan(0);
    expect(TOOL_ALLOWLIST.length).toBeLessThanOrEqual(10);
  });

  it("has no duplicate entries", () => {
    expect(new Set(TOOL_ALLOWLIST).size).toBe(TOOL_ALLOWLIST.length);
  });

  it("only references tools defined in MCP_TOOLS", () => {
    const known = new Set(MCP_TOOLS.map((t) => t.name));
    const unknown = TOOL_ALLOWLIST.filter((n) => !known.has(n));
    expect(unknown).toEqual([]);
  });
});

describe("TOOL_DRILL_IN_HINTS", () => {
  it("only references tools in the allowlist", () => {
    const allowed = new Set(TOOL_ALLOWLIST as readonly string[]);
    const unknown = Object.keys(TOOL_DRILL_IN_HINTS).filter((n) => !allowed.has(n));
    expect(unknown).toEqual([]);
  });

  it("hints look like SPA hash routes", () => {
    for (const [name, hint] of Object.entries(TOOL_DRILL_IN_HINTS)) {
      expect(hint, `hint for ${name}`).toMatch(/^\/#\//);
    }
  });
});

describe("SYSTEM_PROMPT", () => {
  it("is non-empty", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(200);
  });

  // Sentinel phrases that must survive prompt edits — if any disappear,
  // we likely lost a behavioral guarantee covered by the golden set.
  const REQUIRED_TOKENS = [
    "Tool guidance",            // section header that anchors model behavior
    "Numbers etiquette",        // the dollar-formatting rules
    "/legacy",                  // redirect target for unsupported actions
    "never make up",            // anti-hallucination guard
    "Mutations",                // section that gates resolve_review
  ];

  for (const tok of REQUIRED_TOKENS) {
    it(`mentions "${tok}"`, () => {
      expect(SYSTEM_PROMPT).toContain(tok);
    });
  }
});

describe("GOLDEN_CASES", () => {
  it("has unique ids", () => {
    const ids = GOLDEN_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only references tools in the allowlist", () => {
    const allowed = new Set(TOOL_ALLOWLIST as readonly string[]);
    for (const c of GOLDEN_CASES) {
      const refs = [
        ...(c.expects.called ?? []),
        ...(c.expects.not_called ?? []),
        ...(c.expects.called_any_of ?? []),
      ];
      const unknown = refs.filter((n) => !allowed.has(n));
      expect(unknown, `case ${c.id} references unknown tools`).toEqual([]);
    }
  });

  it("each case has a non-empty user message and at least one expectation", () => {
    for (const c of GOLDEN_CASES) {
      expect(c.user.trim().length, `case ${c.id} empty user message`).toBeGreaterThan(0);
      const hasAny =
        c.expects.called || c.expects.not_called || c.expects.called_any_of ||
        c.expects.mentions || c.expects.forbidden;
      expect(hasAny, `case ${c.id} has no expectations`).toBeTruthy();
    }
  });
});
