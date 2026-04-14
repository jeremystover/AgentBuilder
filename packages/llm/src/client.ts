/**
 * Provider-agnostic completion client.
 *
 * Anthropic path uses @anthropic-ai/sdk and enables prompt caching on the
 * system prompt by default (pricing impact: ~10% of input cost on cache hits).
 *
 * Workers AI path calls env.AI.run() — only available inside a Worker. Callers
 * must pass `workersAi` binding for 'edge' tier to work.
 */

import { AgentError } from '@agentbuilder/core';
import Anthropic from '@anthropic-ai/sdk';
import { resolveModel } from './models.js';
import type {
  ChatMessage,
  CompleteRequest,
  CompleteResponse,
  ContentBlock,
  ToolCall,
} from './types.js';

export interface LLMClientOptions {
  anthropicApiKey?: string;
  /** Cloudflare Workers AI binding (env.AI). Required for 'edge' tier. */
  workersAi?: Ai;
}

export class LLMClient {
  private readonly anthropic?: Anthropic;
  private readonly workersAi?: Ai;

  constructor(opts: LLMClientOptions) {
    if (opts.anthropicApiKey) {
      this.anthropic = new Anthropic({ apiKey: opts.anthropicApiKey });
    }
    this.workersAi = opts.workersAi;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const model = resolveModel(req.tier);

    if (model.provider === 'anthropic') {
      if (!this.anthropic) {
        throw new AgentError('Anthropic API key not configured', { code: 'internal' });
      }
      return this.completeAnthropic(req, model.id, req.maxOutputTokens ?? model.maxOutputTokens);
    }

    if (model.provider === 'workers-ai') {
      if (!this.workersAi) {
        throw new AgentError('Workers AI binding not configured', { code: 'internal' });
      }
      return this.completeWorkersAi(req, model.id, req.maxOutputTokens ?? model.maxOutputTokens);
    }

    throw new AgentError(`Unsupported provider: ${model.provider}`, { code: 'internal' });
  }

  private async completeAnthropic(
    req: CompleteRequest,
    modelId: string,
    maxTokens: number,
  ): Promise<CompleteResponse> {
    const shouldCache = req.cacheSystemPrompt ?? true;

    const systemBlocks = shouldCache
      ? [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }]
      : req.system;

    const res = await this.anthropic!.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: req.messages.map(toAnthropicMessage),
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    });

    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        // These fields were added in SDK 0.37+; cast to avoid type errors on
        // older installs. Safe at runtime — undefined if the API doesn't return them.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cacheReadTokens: (res.usage as any).cache_read_input_tokens as number | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cacheWriteTokens: (res.usage as any).cache_creation_input_tokens as number | undefined,
      },
      stopReason: res.stop_reason ?? 'end_turn',
      model: res.model,
    };
  }

  private async completeWorkersAi(
    req: CompleteRequest,
    modelId: string,
    maxTokens: number,
  ): Promise<CompleteResponse> {
    // Workers AI exposes a simple chat schema. Tool-use support varies
    // per model — we pass through when available and ignore otherwise.
    const messages = [
      { role: 'system' as const, content: req.system },
      ...req.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : flattenContentToText(m.content),
      })),
    ];

    // biome-ignore lint/suspicious/noExplicitAny: Workers AI model ids are
    // a string-literal union the binding doesn't expose cleanly.
    const raw = (await this.workersAi!.run(modelId as any, {
      messages,
      max_tokens: maxTokens,
    })) as { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };

    return {
      text: raw.response ?? '',
      toolCalls: [],
      usage: {
        inputTokens: raw.usage?.prompt_tokens ?? 0,
        outputTokens: raw.usage?.completion_tokens ?? 0,
      },
      stopReason: 'end_turn',
      model: modelId,
    };
  }
}

/**
 * Map our internal ChatMessage (with optional structured content) to the
 * Anthropic SDK's MessageParam shape. Plain strings pass through unchanged;
 * ContentBlock[] gets mapped block-by-block.
 */
function toAnthropicMessage(msg: ChatMessage): Anthropic.MessageParam {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }
  const blocks = msg.content.map(toAnthropicBlock);
  return { role: msg.role, content: blocks };
}

// Return type is the SDK's content block union — named ContentBlockParam in
// newer SDK versions. Cast to any to stay compatible with older installs where
// the type name differs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAnthropicBlock(block: ContentBlock): any {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      };
  }
}

/**
 * Workers AI doesn't understand tool_use/tool_result — if we ever route a
 * tool-using conversation through the edge tier, collapse the blocks to
 * plain text so the model at least sees something.
 */
function flattenContentToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[called ${b.name}(${JSON.stringify(b.input)})]`;
      return `[tool result: ${b.content}]`;
    })
    .join('\n');
}
