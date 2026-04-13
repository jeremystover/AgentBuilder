/**
 * runToolLoop — multi-turn tool-use loop.
 *
 * Keeps calling the LLM until either:
 *   - the model emits no more tool calls (stop_reason = 'end_turn'), or
 *   - we hit maxIterations (safety valve against runaway loops).
 *
 * Each iteration:
 *   1. Calls the LLM with the current message history + tool definitions
 *   2. Appends the assistant turn (text + tool_use blocks) to history
 *   3. Executes any tool calls via the provided handlers
 *   4. Appends a user turn containing tool_result blocks
 *
 * Callers own the initial message history and can persist the returned
 * `messages` array to resume the conversation on a later turn.
 */

import type { LLMClient } from './client.js';
import type { ModelTier } from './models.js';
import type { ChatMessage, ContentBlock, ToolDefinition } from './types.js';

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface ToolLoopOptions {
  llm: LLMClient;
  tier: ModelTier;
  system: string;
  initialMessages: ChatMessage[];
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  /** Safety cap on how many LLM calls this loop will make. Default 8. */
  maxIterations?: number;
  /** Called after each LLM call for tracing / logging. */
  onStep?: (step: ToolLoopStep) => void;
}

export interface ToolLoopStep {
  iteration: number;
  toolsCalled: string[];
  text: string;
  stopReason: string;
}

export interface ToolLoopResult {
  /** Final assistant text (from the last non-tool turn) */
  text: string;
  /** Full message history including all tool_use/tool_result blocks */
  messages: ChatMessage[];
  /** Summed usage across all iterations */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  stopReason: string;
  iterations: number;
}

export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const messages: ChatMessage[] = [...opts.initialMessages];
  const maxIter = opts.maxIterations ?? 8;

  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  let lastText = '';
  let lastStopReason = 'end_turn';

  for (let i = 0; i < maxIter; i++) {
    const res = await opts.llm.complete({
      tier: opts.tier,
      system: opts.system,
      messages,
      tools: opts.tools,
    });

    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.cacheReadTokens += res.usage.cacheReadTokens ?? 0;
    usage.cacheWriteTokens += res.usage.cacheWriteTokens ?? 0;
    lastText = res.text;
    lastStopReason = res.stopReason;

    opts.onStep?.({
      iteration: i + 1,
      toolsCalled: res.toolCalls.map((c) => c.name),
      text: res.text,
      stopReason: res.stopReason,
    });

    // Append the assistant turn to history.
    const assistantBlocks: ContentBlock[] = [];
    if (res.text) assistantBlocks.push({ type: 'text', text: res.text });
    for (const tc of res.toolCalls) {
      assistantBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }
    if (assistantBlocks.length > 0) {
      messages.push({ role: 'assistant', content: assistantBlocks });
    }

    // No tool calls → we're done.
    if (res.toolCalls.length === 0) {
      return {
        text: lastText,
        messages,
        usage,
        stopReason: lastStopReason,
        iterations: i + 1,
      };
    }

    // Execute tool handlers and append results as a user turn.
    const resultBlocks: ContentBlock[] = [];
    for (const tc of res.toolCalls) {
      const handler = opts.handlers[tc.name];
      if (!handler) {
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: `Tool "${tc.name}" is not available.`,
          is_error: true,
        });
        continue;
      }
      try {
        const result = await handler(tc.input);
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: `Tool error: ${msg}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: 'user', content: resultBlocks });
  }

  // Hit the iteration cap. Return what we have with a clear stop reason.
  return {
    text: lastText,
    messages,
    usage,
    stopReason: 'max_iterations',
    iterations: maxIter,
  };
}
