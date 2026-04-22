import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../worker-configuration';
import { loadCaseState, saveCaseState } from './lib/case-state.js';
import { intakeInterview, type IntakeInterviewInput } from './mcp/tools/intake_interview.js';
import { buildEvidencePlan, type BuildEvidencePlanInput } from './mcp/tools/build_evidence_plan.js';
import { updateChecklist, type UpdateChecklistInput } from './mcp/tools/update_checklist.js';
import { status, type StatusInput } from './mcp/tools/status.js';

const SYSTEM_PROMPT = `You are Termination Documentation.

Purpose: help a California employee document a possible wrongful-termination,
retaliation, discrimination, harassment, wage-hour, or leave claim. Interview
them about their situation, build a tailored evidence checklist grounded in
US federal and California employment law, and track collection.

Scope rules:
- Not legal advice. Open the first turn with that disclaimer.
- Stay within the responsibilities in SKILL.md.
- Do NOT instruct the user to exfiltrate employer-confidential or trade-secret
  material. Focus on the user's own evidence (their reviews, their comms
  about them, their pay records, their own notes).
- If a request is outside non-goals, suggest which agent to route to instead.
- Before drafting any memo, surface the not-legal-advice reminder again.
- For intake, prefer asking a few questions at a time and then calling the
  intake_interview tool to save answers — not dumping all 15 questions at once.`;

interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
}

interface ToolCallResponse {
  ok: true;
  result: unknown;
}

interface ToolCallError {
  ok: false;
  error: string;
}

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
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return new Response('POST required', { status: 405 });
    }

    if (url.pathname.endsWith('/tool')) {
      return this.handleToolCall(request);
    }

    // Default: REST /chat — conversational passthrough for local testing via
    // tools/chat.sh. Not used by the MCP tool surface; tools go through /tool.
    return this.handleChat(request);
  }

  private async handleToolCall(request: Request): Promise<Response> {
    let body: ToolCallRequest;
    try {
      body = (await request.json()) as ToolCallRequest;
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' } satisfies ToolCallError, 400);
    }

    const state = await loadCaseState(this.ctx.storage);

    try {
      switch (body.name) {
        case 'intake_interview': {
          const { state: next, output } = intakeInterview(
            state,
            body.args as IntakeInterviewInput,
          );
          await saveCaseState(this.ctx.storage, next);
          return json({ ok: true, result: output } satisfies ToolCallResponse);
        }
        case 'build_evidence_plan': {
          const { state: next, output } = buildEvidencePlan(
            state,
            body.args as BuildEvidencePlanInput,
          );
          await saveCaseState(this.ctx.storage, next);
          return json({ ok: true, result: output } satisfies ToolCallResponse);
        }
        case 'update_checklist': {
          const { state: next, output } = updateChecklist(
            state,
            body.args as unknown as UpdateChecklistInput,
          );
          await saveCaseState(this.ctx.storage, next);
          return json({ ok: true, result: output } satisfies ToolCallResponse);
        }
        case 'status': {
          const output = status(state, body.args as StatusInput);
          return json({ ok: true, result: output } satisfies ToolCallResponse);
        }
        default:
          return json(
            { ok: false, error: `Unknown tool: ${body.name}` } satisfies ToolCallError,
            400,
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: message } satisfies ToolCallError, 400);
    }
  }

  private async handleChat(request: Request): Promise<Response> {
    const logger = createLogger({ base: { agent: 'termination-documentation' } });
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

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
