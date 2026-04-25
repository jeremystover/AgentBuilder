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

// ── Streaming variant ──────────────────────────────────────────────────────
// runToolLoopStream — same loop shape as runToolLoop, but emits incremental
// events to the caller's onEvent callback. Used by web UIs that want to
// render Claude's reply progressively (text deltas, tool calls, tool
// results) instead of waiting for the final message.
//
// Event order during a typical loop:
//
//   { type: 'text_delta', text }      0..N times during iteration 1
//   { type: 'tool_use',   id, name, input }   if Claude called any tools
//   { type: 'tool_result', tool_use_id, content }   one per tool call
//   { type: 'iteration_end', stopReason, hasToolCalls }
//   ... (next iteration, more text_deltas, etc.)
//   { type: 'done', text, stopReason, iterations }
//
// Only iterations that DON'T call tools stream "naturally" — the model
// produces text + maybe tool_use blocks, then we stop streaming, run
// tools, and start a new stream for the next iteration. The final
// iteration is the one with no tool calls, and its text is the user-
// facing reply.

export interface ToolLoopStreamEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'iteration_end' | 'done' | 'error';
  /** text_delta */
  text?: string;
  /** tool_use */
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** tool_result */
  content?: string;
  isError?: boolean;
  /** iteration_end */
  stopReason?: string;
  hasToolCalls?: boolean;
  /** done */
  iterations?: number;
  /** error */
  message?: string;
}

export interface ToolLoopStreamOptions extends Omit<ToolLoopOptions, 'onStep'> {
  onEvent: (event: ToolLoopStreamEvent) => void | Promise<void>;
}

export async function runToolLoopStream(opts: ToolLoopStreamOptions): Promise<ToolLoopResult> {
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

  // We need direct access to the streaming API because the regular
  // llm.complete() path is non-streaming. We expect the LLMClient to expose
  // streamAnthropic() — if it doesn't, fall back to non-streaming.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const llmAny = opts.llm as any;
  if (typeof llmAny.streamAnthropic !== 'function') {
    throw new Error('runToolLoopStream requires LLMClient.streamAnthropic — upgrade @agentbuilder/llm');
  }

  for (let i = 0; i < maxIter; i++) {
    const { stream, finalize } = llmAny.streamAnthropic({
      tier: opts.tier,
      system: opts.system,
      messages,
      tools: opts.tools,
    });

    // Live text deltas — fired by the SDK as content_block_delta events
    // arrive. Buffer is flushed via finalMessage()'s text accumulation, but
    // the deltas are what we want to surface to the UI.
    stream.on('text', (delta: string) => {
      void opts.onEvent({ type: 'text_delta', text: delta });
    });

    // Wait for the full message so we can inspect tool_use blocks +
    // stop_reason + usage. text deltas have already been emitted above.
    const res = await finalize();

    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    usage.cacheReadTokens += res.usage.cacheReadTokens ?? 0;
    usage.cacheWriteTokens += res.usage.cacheWriteTokens ?? 0;
    lastText = res.text;
    lastStopReason = res.stopReason;

    // Append the assistant turn to history.
    const assistantBlocks: ContentBlock[] = [];
    if (res.text) assistantBlocks.push({ type: 'text', text: res.text });
    for (const tc of res.toolCalls) {
      assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    if (assistantBlocks.length > 0) {
      messages.push({ role: 'assistant', content: assistantBlocks });
    }

    void opts.onEvent({
      type: 'iteration_end',
      stopReason: res.stopReason,
      hasToolCalls: res.toolCalls.length > 0,
    });

    if (res.toolCalls.length === 0) {
      void opts.onEvent({
        type: 'done',
        text: lastText,
        stopReason: lastStopReason,
        iterations: i + 1,
      });
      return { text: lastText, messages, usage, stopReason: lastStopReason, iterations: i + 1 };
    }

    // Run tool handlers, surface each call + result to the UI, then append
    // a user turn with the tool_results so the next iteration sees them.
    const resultBlocks: ContentBlock[] = [];
    for (const tc of res.toolCalls) {
      void opts.onEvent({
        type: 'tool_use',
        toolUseId: tc.id,
        toolName: tc.name,
        toolInput: tc.input,
      });
      const handler = opts.handlers[tc.name];
      if (!handler) {
        const errText = `Tool "${tc.name}" is not available.`;
        resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: errText, is_error: true });
        void opts.onEvent({ type: 'tool_result', toolUseId: tc.id, content: errText, isError: true });
        continue;
      }
      try {
        const result = await handler(tc.input);
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content });
        void opts.onEvent({ type: 'tool_result', toolUseId: tc.id, content });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errText = `Tool error: ${msg}`;
        resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: errText, is_error: true });
        void opts.onEvent({ type: 'tool_result', toolUseId: tc.id, content: errText, isError: true });
      }
    }
    messages.push({ role: 'user', content: resultBlocks });
  }

  void opts.onEvent({
    type: 'done',
    text: lastText,
    stopReason: 'max_iterations',
    iterations: maxIter,
  });
  return { text: lastText, messages, usage, stopReason: 'max_iterations', iterations: maxIter };
}
