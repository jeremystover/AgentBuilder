import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../worker-configuration';
import { loadCaseState, saveCaseState } from './lib/case-state.js';
import { intakeInterview, type IntakeInterviewInput } from './mcp/tools/intake_interview.js';
import { buildEvidencePlan, type BuildEvidencePlanInput } from './mcp/tools/build_evidence_plan.js';
import { updateChecklist, type UpdateChecklistInput } from './mcp/tools/update_checklist.js';
import { status, type StatusInput } from './mcp/tools/status.js';
import { chronology, type ChronologyInput } from './mcp/tools/chronology.js';
import { generateTopPacket, type GenerateTopPacketInput } from './mcp/tools/generate_top_packet.js';
import { gapReport, type GapReportInput } from './mcp/tools/gap_report.js';
import { draftMemo, type DraftMemoInput } from './mcp/tools/draft_memo.js';

const SYSTEM_PROMPT = `You are Termination Documentation.

Purpose: help a California employee document a possible age / disability /
medical / retaliation / failure-to-accommodate / failure-to-engage / CFRA /
Tameny / whistleblower / wage-hour claim. Interview them, build a tailored
evidence checklist grounded in FEHA (Cal. Gov. Code § 12940 et seq.), CFRA,
Cal. Labor Code, and the federal siblings (Title VII, ADEA, ADA, FMLA), and
track collection through to a lawyer-ready evidence file.

Scope rules:
- Not legal advice. Open the first turn with that disclaimer, and repeat it
  before drafting any memo. You do not represent the user; they should still
  retain licensed California employment counsel.
- Facts, not conclusions. Prefer "Manager said X on date Y" over "Manager
  discriminated." Preserve exact language and separate personal impressions
  from documentary facts.
- If a request is outside non-goals, suggest which agent to route to instead.

Hard guardrails — the agent must enforce these, not just mention them:
- NEVER suggest secretly recording conversations. California Penal Code § 632
  requires all-party consent for confidential communications; secret recording
  may be criminal and will usually be inadmissible. If the user asks about
  recording, walk them through consent and written-memorialization instead.
- NEVER touch attorney–client privileged communications (emails with the
  user's own counsel, work-product, etc.).
- NEVER help collect other employees' personnel files, compensation data,
  medical records, HR investigation records, or trade-secret / confidential
  business documents. Comparator evidence is limited to what the user
  personally and lawfully knows.
- Preserve originals with full email headers and complete threads. NEVER
  rename or re-export files in a way that strips or alters metadata. When
  the original cannot be preserved, direct the user to write a contemporaneous
  factual note (date, actors, exact quote, what was said, who was present).
- Focus on the user's own evidence: their reviews, their comms about them,
  their pay records, their own notes, their own medical records.
- Prioritize these high-value signals aggressively: praise close in time to
  termination, absence of PIP / progressive discipline, ask-to-stay-and-
  transition post-notice, employer knowledge of a medical issue before the
  decision was final, shifting stated reasons (performance vs. restructuring
  vs. fit vs. timing), ageist remarks by decisionmakers, and equity /
  option-exercise-window damages.

Interview method:
- Ask a few questions at a time, then call intake_interview to save answers.
  Do not dump 15 questions at once. intake_interview returns remaining
  questions — follow that list.
- When intake reveals age ≥ 40 + adverse action, employer knowledge of a
  medical issue before decision, leave-related protected activity, or any
  protected activity close-in-time to the adverse action, the tool will
  return suggested_claim_additions. Surface those suggestions to the user
  and ask whether to add them to suspected_claims.
- When collecting an item via update_checklist(mark_collected), fill in the
  evidence-index metadata: source_type, dates, author (and is_decisionmaker),
  recipients, exact_quotes, why_it_matters, claim_tags, and 1–5 scores for
  relevance / reliability / timing_proximity / confidentiality_risk. Preserve
  the original where possible.`;

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
        case 'chronology': {
          const { state: next, output } = chronology(state, body.args as unknown as ChronologyInput);
          await saveCaseState(this.ctx.storage, next);
          return json({ ok: true, result: output } satisfies ToolCallResponse);
        }
        case 'generate_top_packet': {
          const output = generateTopPacket(state, body.args as GenerateTopPacketInput);
          return json({ ok: true, result: output } satisfies ToolCallResponse);
        }
        case 'gap_report': {
          const output = gapReport(state, body.args as GapReportInput);
          return json({ ok: true, result: output } satisfies ToolCallResponse);
        }
        case 'draft_memo': {
          const output = draftMemo(state, body.args as unknown as DraftMemoInput);
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
