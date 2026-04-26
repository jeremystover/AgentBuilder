/**
 * web-chat.ts — POST /api/web/chat handler for the React SPA.
 *
 * Phase 1 scaffold: routes the user's message through the kit's
 * runChatStream with NO tool surface attached. The model can answer
 * generally about books / accounting / planning — but it can't read the
 * CFO's data yet. Phase 2 adds the curated tool registry (≤10 tools) on
 * top of this same handler, mirroring lab-chat.ts in research-agent.
 *
 * Streaming uses the kit's SSE protocol — see types.ChatStreamEvent in
 * src/web/types.ts for the wire shape.
 */

import type { Env } from './types';
import { runChatStream } from '@agentbuilder/web-ui-kit';

interface ChatRequestBody {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: unknown }>;
}

const SYSTEM_PROMPT = `You are the user's CFO — a financial co-pilot for their household and small businesses.
You answer plainly and concisely, oriented toward bookkeeping, taxes, P&L, and budget questions.

You currently have no tools and no access to the user's actual ledger — answer generally
and tell the user when a specific number would require their data. Tools for reading the
review queue, P&L, budget, and transactions are coming in the next phase.`;

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

  try {
    const sseStream = await runChatStream({
      ctx: { tools: {}, env: env as unknown as Record<string, unknown> & { ANTHROPIC_API_KEY?: string } },
      body: { message, history: body.history || [] },
      toolAllowlist: [],
      system: SYSTEM_PROMPT,
      tier: 'default',
      maxIterations: 1,
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
