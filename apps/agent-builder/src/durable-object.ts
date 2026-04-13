/**
 * AgentBuilderDO — the stateful half of the meta-agent.
 *
 * Holds one conversation at a time (phase 1; phase 2 will key by
 * user/session) and dispatches turns to one of three personas:
 *
 *   Architect    – brainstorm with you, decide new-vs-extend, write SKILL.md
 *   Builder      – scaffold, wire Cloudflare bindings, open a PR
 *   Fleet Manager – registry hygiene, overlap detection, shared-code diffs
 *
 * Each persona is a narrow subagent with its own system prompt, tool
 * allowlist, and model tier. The DO orchestrates handoffs.
 */

import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../worker-configuration';
import { runArchitectTurn } from './personas/architect.js';
import { runBuilderTurn } from './personas/builder.js';
import { runFleetManagerTurn } from './personas/fleet-manager.js';
import type { ConversationTurn, PersonaId } from './types.js';

export class AgentBuilderDO extends DurableObject<Env> {
  private readonly llm: LLMClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.llm = new LLMClient({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      workersAi: env.AI,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const logger = createLogger({ base: { agent: 'agent-builder' } });

    if (request.method !== 'POST') {
      return new Response('POST required', { status: 405 });
    }

    const body = (await request.json()) as {
      message: string;
      persona?: PersonaId;
    };

    const persona: PersonaId = body.persona ?? 'architect';
    const turn: ConversationTurn = {
      persona,
      input: body.message,
      // Phase 2 will load history from DO SQLite.
      history: [],
    };

    const log = logger.child({ persona });
    log.info('turn.start');

    const result = await this.dispatch(turn);

    log.info('turn.end', { tokens: result.usage });
    return Response.json(result);
  }

  private dispatch(turn: ConversationTurn) {
    switch (turn.persona) {
      case 'architect':
        return runArchitectTurn({ llm: this.llm, turn });
      case 'builder':
        return runBuilderTurn({ llm: this.llm, turn });
      case 'fleet-manager':
        return runFleetManagerTurn({ llm: this.llm, turn });
    }
  }
}
