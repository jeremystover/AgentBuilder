/**
 * AgentBuilderDO — the stateful half of the meta-agent.
 *
 * One DO instance per session. Conversation history (including tool_use
 * and tool_result blocks) is persisted in DO storage so subsequent turns
 * pick up where the previous one left off.
 *
 * Routing between personas:
 *   - Caller can set `persona` explicitly on each turn.
 *   - If the previous turn ended with HANDOFF: <name>, the next turn
 *     defaults to that persona unless the caller overrides.
 *
 * Storage keys per session:
 *   session:<id>:history  → ChatMessage[]
 *   session:<id>:meta     → { persona, lastHandoff, createdAt, updatedAt }
 */

import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@agentbuilder/core';
import { type ChatMessage, LLMClient } from '@agentbuilder/llm';
import { MemoryRegistryStore } from '@agentbuilder/registry';
import registryData from '../../../registry/agents.json';
import type { Env } from '../worker-configuration';
import { runArchitectTurn } from './personas/architect.js';
import { runBuilderTurn } from './personas/builder.js';
import { runFleetManagerTurn } from './personas/fleet-manager.js';
import type { PersonaId } from './types.js';

export interface ChatRequestBody {
  message: string;
  sessionId?: string;
  persona?: PersonaId;
}

export interface ChatResponseBody {
  sessionId: string;
  persona: PersonaId;
  reply: string;
  handoffTo?: PersonaId;
  iterations: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

interface SessionMeta {
  persona: PersonaId;
  lastHandoff?: PersonaId;
  createdAt: number;
  updatedAt: number;
}

export class AgentBuilderDO extends DurableObject<Env> {
  private readonly llm: LLMClient;
  private readonly registry: MemoryRegistryStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.llm = new LLMClient({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      workersAi: env.AI,
    });
    this.registry = new MemoryRegistryStore(registryData);
  }

  override async fetch(request: Request): Promise<Response> {
    const logger = createLogger({ base: { agent: 'agent-builder' } });

    if (request.method !== 'POST') {
      return new Response('POST required', { status: 405 });
    }

    let body: ChatRequestBody;
    try {
      body = (await request.json()) as ChatRequestBody;
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }

    if (!body.message || typeof body.message !== 'string') {
      return new Response('`message` is required', { status: 400 });
    }

    const sessionId = body.sessionId ?? crypto.randomUUID();
    const history = await this.loadHistory(sessionId);
    const meta = await this.loadMeta(sessionId);

    // Persona selection priority: explicit request > previous handoff > default
    const persona: PersonaId = body.persona ?? meta?.lastHandoff ?? meta?.persona ?? 'architect';

    const log = logger.child({ sessionId, persona, iteration: history.length });
    log.info('turn.start', { message: body.message.slice(0, 120) });

    const result = await this.dispatch(persona, history, body.message);

    await this.saveHistory(sessionId, result.messages);
    await this.saveMeta(sessionId, {
      persona,
      lastHandoff: result.handoffTo,
      createdAt: meta?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });

    log.info('turn.end', {
      iterations: result.iterations,
      usage: result.usage,
      handoffTo: result.handoffTo,
    });

    const responseBody: ChatResponseBody = {
      sessionId,
      persona,
      reply: result.reply,
      handoffTo: result.handoffTo,
      iterations: result.iterations,
      usage: result.usage,
    };
    return Response.json(responseBody);
  }

  private async dispatch(persona: PersonaId, history: ChatMessage[], userMessage: string) {
    switch (persona) {
      case 'architect':
        return runArchitectTurn({
          llm: this.llm,
          registry: this.registry,
          history,
          userMessage,
        });
      case 'builder':
        return runBuilderTurn({
          llm: this.llm,
          registry: this.registry,
          history,
          userMessage,
        });
      case 'fleet-manager':
        return runFleetManagerTurn({
          llm: this.llm,
          registry: this.registry,
          history,
          userMessage,
        });
    }
  }

  private async loadHistory(sessionId: string): Promise<ChatMessage[]> {
    const stored = await this.ctx.storage.get<ChatMessage[]>(`session:${sessionId}:history`);
    return stored ?? [];
  }

  private async saveHistory(sessionId: string, messages: ChatMessage[]): Promise<void> {
    await this.ctx.storage.put(`session:${sessionId}:history`, messages);
  }

  private async loadMeta(sessionId: string): Promise<SessionMeta | undefined> {
    return this.ctx.storage.get<SessionMeta>(`session:${sessionId}:meta`);
  }

  private async saveMeta(sessionId: string, meta: SessionMeta): Promise<void> {
    await this.ctx.storage.put(`session:${sessionId}:meta`, meta);
  }
}
