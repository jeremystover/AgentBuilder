import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../worker-configuration';

const SYSTEM_PROMPT = `You are Termination Documentation.

Purpose: Guides a California employee through documenting a possible wrongful-termination or hostile-workplace claim: interviews the user, builds an evidence checklist grounded in US and California employment law, tracks collection, ingests Claude.ai file uploads into an organized Google Drive folder, drafts a Google Docs evidence memo for counsel or HR, and walks through a 24-hour company-exit checklist.

Scope rules:
- Stay within the responsibilities listed in SKILL.md.
- If a request falls outside your non-goals, suggest which agent to route to instead.
- Prefer tools from @agentbuilder/* shared packages over reinventing.`;

export class TerminationDocumentationDO extends DurableObject<Env> {
  private readonly llm: LLMClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.llm = new LLMClient({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      workersAi: env.AI,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const logger = createLogger({ base: { agent: 'termination-documentation' } });
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
