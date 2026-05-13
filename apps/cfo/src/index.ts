/**
 * CFO worker entrypoint (Phase 1a — scaffold).
 *
 * Surfaces:
 *   - GET    /health                     — db + email sync health
 *   - POST   /teller/enroll              — start a Teller enrollment
 *   - GET    /teller/accounts            — list enrolled accounts
 *   - POST   /teller/sync                — sync transactions into raw_transactions
 *   - DELETE /teller/enrollments/:id     — remove an enrollment
 *   - GET    /gmail/status               — per-vendor email sync counts
 *   - POST   /gmail/sync                 — run email enrichment for all vendors
 *   - POST   /gmail/sync/:vendor         — run for one vendor (amazon|venmo|apple|etsy)
 *
 * Scheduled:
 *   - "0 9 * * *"  → nightly Teller sync + email enrichment (~05:00 ET)
 */

import { runCron } from '@agentbuilder/observability';
import type { Env } from './types';
import { jsonError } from './types';

import { handleHealth } from './routes/health';
import {
  handleTellerEnroll,
  handleTellerListAccounts,
  handleTellerSync,
  handleTellerDeleteEnrollment,
  runTellerSync,
} from './routes/teller';
import {
  handleGmailSyncAll,
  handleGmailSyncVendor,
  handleGmailStatus,
} from './routes/gmail';
import { runEmailSync } from './lib/email-sync';

type Handler = (req: Request, env: Env, ...params: string[]) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const ROUTES: Route[] = [
  { method: 'GET',    pattern: /^\/health$/,                          handler: (req, env) => handleHealth(req, env) },
  { method: 'POST',   pattern: /^\/teller\/enroll$/,                  handler: (req, env) => handleTellerEnroll(req, env) },
  { method: 'GET',    pattern: /^\/teller\/accounts$/,                handler: (req, env) => handleTellerListAccounts(req, env) },
  { method: 'POST',   pattern: /^\/teller\/sync$/,                    handler: (req, env) => handleTellerSync(req, env) },
  { method: 'DELETE', pattern: /^\/teller\/enrollments\/([^/]+)$/,    handler: (req, env, id) => handleTellerDeleteEnrollment(req, env, id!) },
  { method: 'GET',    pattern: /^\/gmail\/status$/,                     handler: (req, env) => handleGmailStatus(req, env) },
  { method: 'POST',   pattern: /^\/gmail\/sync$/,                       handler: (req, env) => handleGmailSyncAll(req, env) },
  { method: 'POST',   pattern: /^\/gmail\/sync\/([^/]+)$/,              handler: (req, env, vendor) => handleGmailSyncVendor(req, env, vendor!) },
];

async function handleNightlySync(env: Env): Promise<void> {
  await runTellerSync(env);
  await runEmailSync(env);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    for (const route of ROUTES) {
      if (route.method !== request.method) continue;
      const match = path.match(route.pattern);
      if (match) {
        try {
          const params = match.slice(1).map(p => p ?? '');
          const response = await route.handler(request, env, ...params);
          response.headers.set('Access-Control-Allow-Origin', '*');
          return response;
        } catch (err) {
          console.error(`Error in ${request.method} ${path}:`, err);
          return jsonError(`Internal server error: ${String(err)}`, 500);
        }
      }
    }

    return jsonError('Not found', 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 9 * * *') {
      ctx.waitUntil(
        runCron(
          env,
          { agentId: 'cfo', trigger: 'nightly-sync', cron: event.cron },
          () => handleNightlySync(env),
        ),
      );
      return;
    }

    console.warn('[scheduled] unknown cron expression', event.cron);
  },
} satisfies ExportedHandler<Env>;
