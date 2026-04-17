import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../worker-configuration';

const SYSTEM_PROMPT = `You are World Monitor.

Purpose: Wraps the worldmonitor-mcp server to surface live markets, geopolitics, conflict, climate, supply chain, cyber, and infrastructure data to the fleet via MCP.

Scope rules:
- Stay within the responsibilities listed in SKILL.md.
- If a request falls outside your non-goals, suggest which agent to route to instead.
- Prefer tools from @agentbuilder/* shared packages over reinventing.`;

export class WorldMonitorDO extends DurableObject<Env> {
  private readonly llm: LLMClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.llm = new LLMClient({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      workersAi: env.AI,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const logger = createLogger({ base: { agent: 'world-monitor' } });
    if (request.method !== 'POST') return new Response('POST required', { status: 405 });

    const { message } = (await request.json()) as { message: string };
    logger.info('turn.start');

    const res = await this.llm.complete({
      tier: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
    });

    logger.info('turn.end', { usage: res.usage });
    return Response.json({ reply: res.text, usage: res.usage });
  }
}
