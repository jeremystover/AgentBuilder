/**
 * Provider-agnostic completion client.
 *
 * Anthropic path uses @anthropic-ai/sdk and enables prompt caching on the
 * system prompt by default (pricing impact: ~10% of input cost on cache hits).
 *
 * Workers AI path calls env.AI.run() — only available inside a Worker. Callers
 * must pass `workersAi` binding for 'edge' tier to work.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AgentError } from '@agentbuilder/core';
import { resolveModel } from './models.js';
import type { CompleteRequest, CompleteResponse, ToolCall } from './types.js';

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
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
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
        cacheReadTokens: res.usage.cache_read_input_tokens ?? undefined,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? undefined,
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
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
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
