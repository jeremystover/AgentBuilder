/**
 * CFO worker entrypoint.
 *
 * Surfaces:
 *   - GET    /health                            db + email sync health
 *   - GET    /login                             login form
 *   - POST   /login                             create cookie session
 *   - GET    /logout                            destroy session, redirect
 *   - GET    /api/web/snapshot                  dashboard counters
 *   - GET    /api/web/entities                  entity dropdown
 *   - GET    /api/web/categories                category dropdown
 *   - GET    /api/web/accounts                  gather accounts list
 *   - PUT    /api/web/accounts/:id              update account entity/active
 *   - GET    /api/web/review                    review queue (filtered/paged)
 *   - GET    /api/web/review/:id                review row detail
 *   - PUT    /api/web/review/:id                edit fields on a review row
 *   - POST   /api/web/review/:id/approve        promote raw → transactions
 *   - POST   /api/web/review/:id/advance        promote waiting → staged
 *   - POST   /api/web/review/bulk               bulk action over ids/filter
 *   - GET    /api/web/transactions              approved transactions
 *   - PUT    /api/web/transactions/:id          edit / re-open
 *   - GET    /api/web/rules                     rules list
 *   - POST   /api/web/rules                     create rule
 *   - GET    /api/web/gather/status             sync health for Gather page
 *   - POST   /api/web/gather/sync/:source       manual sync trigger
 *   - GET    /api/web/review/status              queue counts (also a tool)
 *   - GET    /api/web/review/next                interview-mode next row
 *   - GET    /api/web/transactions/summary       entity/category rollup
 *   - POST   /api/web/chat                       SSE streaming chat (10 tools)
 *   - POST   /mcp                                JSON-RPC 2.0 (Bearer MCP_HTTP_KEY)
 *   - POST   /teller/enroll, GET /teller/accounts, POST /teller/sync,
 *     DELETE /teller/enrollments/:id            external Teller surface
 *   - GET    /gmail/status, POST /gmail/sync, POST /gmail/sync/:vendor
 *                                               external Gmail surface
 *   - GET   any unmatched (cookie-gated)        SPA shell from ASSETS
 *
 * Scheduled:
 *   - "0 9 * * *"  → nightly Teller sync + email enrichment + auto-classify
 *                    (runs at ~05:00 ET).
 */

import { runCron } from '@agentbuilder/observability';
import type { Env } from './types';
import { jsonError } from './types';

import { handleHealth } from './routes/health';
import {
  handleTellerEnroll, handleTellerListAccounts, handleTellerSync,
  handleTellerDeleteEnrollment, runTellerSync,
} from './routes/teller';
import { handleGmailSyncAll, handleGmailSyncVendor, handleGmailStatus } from './routes/gmail';
import { runEmailSync } from './lib/email-sync';

import { handleSnapshot } from './routes/web-snapshot';
import {
  handleListEntities, handleListCategories, handleListAccounts, handleUpdateAccount,
} from './routes/web-lookups';
import {
  handleListReview, handleGetReview, handleUpdateReview,
  handleApproveReview, handleBulkReview, handleAdvanceWaiting,
  handleReviewNext, handleReviewStatus,
} from './routes/web-review';
import { handleListTransactions, handleUpdateTransaction, handleTransactionsSummary } from './routes/web-transactions';
import { handleListRules, handleCreateRule } from './routes/web-rules';
import { handleGatherStatus, handleGatherSync } from './routes/web-gather';
import { handleMcp, type JsonRpcMessage } from './mcp-tools';
import { handleWebChat } from './web-chat';
import { runClassify } from './lib/classify';

import {
  createSession, destroySession, requireWebSession, requireApiAuth,
  setSessionCookieHeader, clearSessionCookieHeader, verifyPassword, loginHtml,
} from './lib/sessions';

type Handler = (req: Request, env: Env, ...params: string[]) => Promise<Response>;
interface Route { method: string; pattern: RegExp; handler: Handler; auth: 'public' | 'cookie' | 'api' }

const ROUTES: Route[] = [
  // Public ops surfaces (Teller webhook-style + health).
  { method: 'GET',    pattern: /^\/health$/,                            auth: 'public', handler: (req, env) => handleHealth(req, env) },
  { method: 'POST',   pattern: /^\/teller\/enroll$/,                    auth: 'public', handler: (req, env) => handleTellerEnroll(req, env) },
  { method: 'GET',    pattern: /^\/teller\/accounts$/,                  auth: 'public', handler: (req, env) => handleTellerListAccounts(req, env) },
  { method: 'POST',   pattern: /^\/teller\/sync$/,                      auth: 'public', handler: (req, env) => handleTellerSync(req, env) },
  { method: 'DELETE', pattern: /^\/teller\/enrollments\/([^/]+)$/,      auth: 'public', handler: (req, env, id) => handleTellerDeleteEnrollment(req, env, id!) },
  { method: 'GET',    pattern: /^\/gmail\/status$/,                     auth: 'public', handler: (req, env) => handleGmailStatus(req, env) },
  { method: 'POST',   pattern: /^\/gmail\/sync$/,                       auth: 'public', handler: (req, env) => handleGmailSyncAll(req, env) },
  { method: 'POST',   pattern: /^\/gmail\/sync\/([^/]+)$/,              auth: 'public', handler: (req, env, vendor) => handleGmailSyncVendor(req, env, vendor!) },

  // SPA-facing API (cookie or bearer)
  { method: 'GET',    pattern: /^\/api\/web\/snapshot$/,                auth: 'api',    handler: (req, env) => handleSnapshot(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/entities$/,                auth: 'api',    handler: (req, env) => handleListEntities(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/categories$/,              auth: 'api',    handler: (req, env) => handleListCategories(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/accounts$/,                auth: 'api',    handler: (req, env) => handleListAccounts(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/accounts\/([^/]+)$/,       auth: 'api',    handler: (req, env, id) => handleUpdateAccount(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/review$/,                  auth: 'api',    handler: (req, env) => handleListReview(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/review\/status$/,          auth: 'api',    handler: (req, env) => handleReviewStatus(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/review\/next$/,            auth: 'api',    handler: (req, env) => handleReviewNext(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/review\/bulk$/,            auth: 'api',    handler: (req, env) => handleBulkReview(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/review\/([^/]+)$/,         auth: 'api',    handler: (req, env, id) => handleGetReview(req, env, id!) },
  { method: 'PUT',    pattern: /^\/api\/web\/review\/([^/]+)$/,         auth: 'api',    handler: (req, env, id) => handleUpdateReview(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/review\/([^/]+)\/approve$/,auth: 'api',    handler: (req, env, id) => handleApproveReview(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/review\/([^/]+)\/advance$/,auth: 'api',    handler: (req, env, id) => handleAdvanceWaiting(req, env, id!) },
  { method: 'GET',    pattern: /^\/api\/web\/transactions$/,            auth: 'api',    handler: (req, env) => handleListTransactions(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/transactions\/summary$/,   auth: 'api',    handler: (req, env) => handleTransactionsSummary(req, env) },
  { method: 'PUT',    pattern: /^\/api\/web\/transactions\/([^/]+)$/,   auth: 'api',    handler: (req, env, id) => handleUpdateTransaction(req, env, id!) },
  { method: 'POST',   pattern: /^\/api\/web\/chat$/,                    auth: 'api',    handler: (req, env) => handleWebChat(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/rules$/,                   auth: 'api',    handler: (req, env) => handleListRules(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/rules$/,                   auth: 'api',    handler: (req, env) => handleCreateRule(req, env) },
  { method: 'GET',    pattern: /^\/api\/web\/gather\/status$/,          auth: 'api',    handler: (req, env) => handleGatherStatus(req, env) },
  { method: 'POST',   pattern: /^\/api\/web\/gather\/sync\/(.+)$/,      auth: 'api',    handler: (req, env, source) => handleGatherSync(req, env, source!) },
];

function requireMcpAuth(request: Request, env: Env): { ok: true } | { ok: false; response: Response } {
  const expected = env.MCP_HTTP_KEY ?? '';
  if (!expected) return { ok: true }; // dev only
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? new URL(request.url).searchParams.get('key') ?? '';
  if (token && token === expected) return { ok: true };
  return { ok: false, response: new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } }) };
}

async function handleNightlySync(env: Env): Promise<void> {
  await runTellerSync(env);
  await runEmailSync(env);
  // Auto-categorize anything newly staged before the user wakes up.
  await runClassify(env).catch(err => console.warn('[cron] classify failed', err));
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
    const method = request.method;

    // ── Login / logout ────────────────────────────────────────────────────
    if (path === '/login' && method === 'GET') {
      return new Response(loginHtml(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/login' && method === 'POST') {
      if (!env.WEB_UI_PASSWORD) {
        return new Response(loginHtml({ error: 'WEB_UI_PASSWORD is not configured.' }), {
          status: 500, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const form = await request.formData().catch(() => null);
      const password = form?.get('password') ?? '';
      if (!verifyPassword(env, password)) {
        return new Response(loginHtml({ error: 'Wrong password.' }), {
          status: 401, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const { sessionId } = await createSession(env);
      const secure = url.protocol === 'https:';
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          'set-cookie': setSessionCookieHeader(sessionId, { secure }),
        },
      });
    }
    if (path === '/logout') {
      const session = await requireWebSession(request, env, { mode: 'page' });
      if (session.ok && session.sessionId) await destroySession(env, session.sessionId);
      const secure = url.protocol === 'https:';
      return new Response(null, {
        status: 302,
        headers: {
          location: '/login',
          'set-cookie': clearSessionCookieHeader({ secure }),
        },
      });
    }

    // ── MCP JSON-RPC ─────────────────────────────────────────────────────
    if (path === '/mcp' && method === 'POST') {
      const auth = requireMcpAuth(request, env);
      if (!auth.ok) return auth.response;
      let msg: JsonRpcMessage;
      try {
        msg = await request.json() as JsonRpcMessage;
      } catch {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      try {
        const out = await handleMcp(msg, env);
        if (out === null) return new Response(null, { status: 204 });
        return Response.json(out);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message } });
      }
    }

    // ── Match registered routes ───────────────────────────────────────────
    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const match = path.match(route.pattern);
      if (!match) continue;

      if (route.auth === 'api') {
        const auth = await requireApiAuth(request, env);
        if (!auth.ok) return auth.response;
      }
      try {
        const params = match.slice(1).map(p => p ?? '');
        const response = await route.handler(request, env, ...params);
        response.headers.set('Access-Control-Allow-Origin', '*');
        return response;
      } catch (err) {
        console.error(`Error in ${method} ${path}:`, err);
        return jsonError(`Internal server error: ${String(err)}`, 500);
      }
    }

    // ── SPA shell: cookie-gated, fall through to ASSETS ───────────────────
    if (method === 'GET') {
      const session = await requireWebSession(request, env, { mode: 'page' });
      if (!session.ok) return session.response;
      // Vite-built static assets land under /assets/* (hashed). Anything
      // else is the SPA shell.
      if (path.startsWith('/assets/')) return env.ASSETS.fetch(request);
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString(), request));
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
