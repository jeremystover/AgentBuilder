/**
 * Live AI-1 evals. Hits the Anthropic API. Skipped by default — set
 * ANTHROPIC_API_KEY in your shell to enable:
 *
 *   pnpm eval                # just the live evals
 *   ANTHROPIC_API_KEY=... pnpm test    # full suite, evals included
 *
 * These cost money and take ~5-15s per case. Run before shipping a
 * prompt change; not on every CI run.
 */

import { describe, it, expect } from "vitest";
import { GOLDEN_CASES } from "./golden";
import {
  runEvalCase,
  assertCalled, assertNotCalled, assertCalledAnyOf,
  assertReplyMentions, assertReplyForbids,
} from "./runner";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const HAS_KEY = !!API_KEY;

describe.skipIf(!HAS_KEY)("AI-1 golden set (live)", () => {
  // Run cases serially so a transient rate-limit surfaces clearly.
  for (const c of GOLDEN_CASES) {
    it(`${c.id} — ${c.why}`, async () => {
      const result = await runEvalCase({
        apiKey: API_KEY!,
        message: c.user,
        maxIterations: c.expects.max_iterations ?? 6,
      });

      const errors: string[] = [];
      if (c.expects.called)        push(errors, assertCalled(result.toolCalls, c.expects.called));
      if (c.expects.not_called)    push(errors, assertNotCalled(result.toolCalls, c.expects.not_called));
      if (c.expects.called_any_of) push(errors, assertCalledAnyOf(result.toolCalls, c.expects.called_any_of));
      if (c.expects.mentions)      push(errors, assertReplyMentions(result.reply, c.expects.mentions));
      if (c.expects.forbidden)     push(errors, assertReplyForbids(result.reply, c.expects.forbidden));

      if (errors.length > 0) {
        const detail = [
          `Tool calls: ${result.toolCalls.map((c) => c.name).join(" → ") || "(none)"}`,
          `Iterations: ${result.iterations}`,
          `Reply: ${result.reply.slice(0, 300)}…`,
        ].join("\n");
        throw new Error(`${errors.join("\n")}\n\n${detail}`);
      }
      expect(errors).toHaveLength(0);
    }, 30_000);
  }
});

if (!HAS_KEY) {
  describe("AI-1 golden set (skipped)", () => {
    it("set ANTHROPIC_API_KEY to enable live evals", () => {
      // Surface the skip explicitly so devs notice the suite even when
      // gated. No-op assertion.
      expect(GOLDEN_CASES.length).toBeGreaterThan(0);
    });
  });
}

function push(arr: string[], v: string | null) {
  if (v) arr.push(v);
}
