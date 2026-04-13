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

    // CORS headers for custom tool integrations
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/health') {
      return Response.json(
        {
          status: 'ok',
          agent: 'agent-builder',
          phase: 2,
          personas: ['architect', 'builder', 'fleet-manager'],
        },
        { headers: corsHeaders }
      );
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
      const response = await stub.fetch(request);

      // Add CORS headers to the DO response
      const newResponse = new Response(response.body, response);
      for (const [key, value] of Object.entries(corsHeaders)) {
        newResponse.headers.set(key, value);
      }
      return newResponse;
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;
