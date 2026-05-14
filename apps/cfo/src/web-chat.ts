/**
 * POST /api/web/chat — SSE-streaming chat handler for the SPA. Uses the
 * kit's runChatStream wired up to the 10-tool allowlist from
 * web-chat-tools.ts.
 */

import type { Env } from './types';
import { runChatStream } from '@agentbuilder/web-ui-kit';
import { buildWebChatTools, TOOL_ALLOWLIST } from './web-chat-tools';

interface ChatRequestBody {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  pageContext?: Record<string, unknown>;
}

const SYSTEM_PROMPT = `You are a financial assistant for Jeremy and Elyse. You help with:
- Reviewing and categorizing transactions (use review_next / review_resolve / review_bulk_accept)
- Understanding spending patterns (use transactions_summary / transactions_list)
- Managing classification rules (use rules_list / rules_create)
- Generating Schedule C/E and family summary reports (use report_list_configs / report_generate)

Start any review session by calling review_status first.

When the user corrects a categorization and the same merchant will appear again, proactively offer to create a rule.

For report generation, always call report_list_configs first to confirm the config_id before calling report_generate. report_generate returns a Google Drive URL — surface it as a clickable link.

Amounts are displayed with credit-card sign convention: positive = expense, negative = income/refund.`;

export async function handleWebChat(request: Request, env: Env): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  let body: ChatRequestBody;
  try {
    body = await request.json() as ChatRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const message = String(body?.message ?? '').trim();
  if (!message) {
    return new Response(JSON.stringify({ error: 'message is required' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const tools = buildWebChatTools(env);

  try {
    const stream = await runChatStream({
      ctx: { tools, env: env as unknown as Record<string, unknown> & { ANTHROPIC_API_KEY?: string } },
      body: { message, history: body.history ?? [], pageContext: body.pageContext },
      toolAllowlist: [...TOOL_ALLOWLIST],
      system: SYSTEM_PROMPT,
      tier: 'default',
      maxIterations: 8,
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('ANTHROPIC_API_KEY') ? 503 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}
