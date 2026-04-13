/**
 * AgentBuilder — the meta-agent.
 *
 * Routes:
 *   GET  /health         → { status: 'ok', ... }
 *   POST /chat           → { message, sessionId?, persona? }
 *                          → delegates to a Durable Object keyed by sessionId
 *
 * Each session pins to a single Durable Object instance so conversation
 * history (including tool_use / tool_result blocks) stays consistent
 * across turns without needing external storage.
 */

import type { Env } from '../worker-configuration';
export { AgentBuilderDO } from './durable-object.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        agent: 'agent-builder',
        phase: 2,
        personas: ['architect', 'builder', 'fleet-manager'],
      });
    }

    if (url.pathname === '/chat' && request.method === 'POST') {
      // Peek at sessionId to route consistently to the same DO. If the
      // client doesn't provide one, the DO will mint a fresh UUID and
      // return it — the client should echo it on subsequent turns.
      let sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        const cloned = request.clone();
        try {
          const body = (await cloned.json()) as { sessionId?: string };
          sessionId = body.sessionId ?? null;
        } catch {
          // fall through — DO will return 400 for malformed bodies
        }
      }

      const doKey = sessionId ?? crypto.randomUUID();
      const id = env.AGENT_BUILDER_DO.idFromName(doKey);
      const stub = env.AGENT_BUILDER_DO.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
