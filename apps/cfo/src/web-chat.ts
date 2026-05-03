/**
 * web-chat.ts — POST /api/web/chat handler for the React SPA.
 *
 * Routes the user's message through the kit's runChatStream wired up to
 * a curated 10-tool registry (see web-chat-tools.ts). The model can read
 * the review queue, P&L, budgets, transactions, and Schedule C/E
 * reports, plus run classifications and resolve review items. It can NOT
 * trigger Teller syncs, ingest CSVs, edit rules, or commit bookkeeping
 * decisions — those have UI confirmation flows of their own.
 *
 * Streaming uses the kit's SSE protocol — see ChatStreamEvent in
 * src/web/types.ts for the wire shape.
 */

import type { Env } from './types';
import { runChatStream } from '@agentbuilder/web-ui-kit';
import { buildWebChatTools, TOOL_ALLOWLIST } from './web-chat-tools';

interface ChatRequestBody {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: unknown }>;
}

const SYSTEM_PROMPT = `You are the user's CFO — a financial co-pilot for their household and small businesses (Elyse coaching, Jeremy coaching, Whitford House Airbnb, family/personal).

You have read access to live ledger data and a small set of write actions. Use tools when the user asks a question that depends on actual numbers. For pure conceptual or tax-rule questions, answer from your own knowledge without calling tools.

Tool guidance:
- "How are we doing?" / "what's the P&L?" → call pnl_all_entities (preset: this_month by default; ask if they meant a different window)
- "Are we over budget?" / "how's groceries?" → call budget_status
- "What needs my attention?" / "what's left to review?" → call list_review_queue, then next_review_item to drill in
- "What's my Schedule C looking like?" → call schedule_c_report with the active tax year
- "Can you re-classify these?" / "run the AI on the unsorted ones" → call classify_transactions
- "Walk me through the books for elyse coaching" → start_bookkeeping_session, then get_bookkeeping_batch

Numbers etiquette:
- Always show dollar amounts as $1,234 (no cents on summary numbers; cents OK on individual transactions).
- When citing a P&L or budget number, say what window it's for ("March", "year-to-date", etc.).
- If a tool returns an error or empty result, say so plainly — never make up a number.
- Use the four entity slugs as-is (elyse_coaching, jeremy_coaching, airbnb_activity, family_personal) when calling tools, but humanize them in replies ("Elyse coaching", "Whitford House Airbnb", etc.).

Mutations:
- resolve_review writes — only call it when the user explicitly tells you to confirm or override a specific review item. Echo back what you're about to do before calling.
- classify_transactions kicks off a background AI pass. Confirm scope first if it's not obvious from the user's message.

Scope:
- Anything that needs a Teller sync, a CSV/Tiller/Amazon import, a budget category mutation, a rule edit, or a bookkeeping commit lives in the legacy UI at /legacy. Send the user there for those.`;

export async function handleWebChat(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
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
    const sseStream = await runChatStream({
      ctx: { tools, env: env as unknown as Record<string, unknown> & { ANTHROPIC_API_KEY?: string } },
      body: { message, history: body.history || [] },
      toolAllowlist: [...TOOL_ALLOWLIST],
      system: SYSTEM_PROMPT,
      tier: 'default',
      maxIterations: 8,
    });
    return new Response(sseStream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        // Cloudflare proxies will buffer SSE without this hint.
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
