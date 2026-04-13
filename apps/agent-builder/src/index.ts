/**
 * AgentBuilder — the meta-agent.
 *
 * Entrypoint Worker delegates to a single Durable Object per session. The
 * DO runs a three-persona loop (Architect / Builder / Fleet Manager) and
 * persists conversation state between turns.
 *
 * Phase 1: the Worker routes requests, the DO is stubbed with the persona
 * skeleton and a minimal tool surface. The persona loops are implemented
 * in phase 2.
 */

import type { Env } from '../worker-configuration';
export { AgentBuilderDO } from './durable-object.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', agent: 'agent-builder', phase: 1 });
    }

    // Route everything else into a named Durable Object instance. For now
    // we use a single global instance; later we'll key by user/session.
    if (url.pathname.startsWith('/chat')) {
      const id = env.AGENT_BUILDER_DO.idFromName('global');
      const stub = env.AGENT_BUILDER_DO.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
