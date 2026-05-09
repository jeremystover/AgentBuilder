/**
 * CFO worker entrypoint.
 *
 * Hybrid agent: serves three surfaces off a single worker.
 *
 *   1. REST API (`/health`, `/bank/*`, `/transactions/*`, `/classify/*`,
 *      `/reports/*`, `/imports/*`, `/rules/*`, etc.) — the original
 *      tax-prep surface the SPA still speaks to. Migrated verbatim from
 *      jeremystover/tax-prep, minus Plaid.
 *
 *   2. SPA (`/` and unmatched GETs) — the same public/index.html web UI
 *      bound via `[assets]`.
 *
 *   3. MCP JSON-RPC (`POST /mcp`) — Claude.ai custom tool integration.
 *      Exposes the CFO's conversational surface as typed tools wrapping
 *      the REST handlers. See mcp-tools.ts.
 *
 * Migration notes:
 *   - CORS headers are applied on all REST responses so the SPA and
 *     external callers still work post-rename.
 *   - /mcp is gated by MCP_HTTP_KEY if set (unset = open, dev only).
 *   - No Durable Object — the CFO is D1-backed so a DO would just add
 *     serialization cost. If we need per-session chat state later we'll
 *     add one then.
 */

import { runCron } from '@agentbuilder/observability';
import type { Env } from './types';
import { jsonError } from './types';

// Routes
import { handleSetup } from './routes/setup';
import { handleGetBankConfig, handleStartBankConnect, handleCompleteBankConnect, handleBankSync } from './routes/bank';
import { handleListAccounts, handleUpdateAccount } from './routes/accounts';
import { handleListTransactions, handleGetTransaction, handleDeleteTransaction, handleManualClassify, handleSplitTransaction } from './routes/transactions';
import { handleRunClassification, handleClassifySingle, handleReapplyAccountRules } from './routes/classify';
import { handleListReview, handleResolveReview, handleBulkResolveReview, handleNextReviewItem } from './routes/review';
import { handleScheduleC, handleScheduleE, handleSummary, handleExport, handleSnapshot } from './routes/reports';
import { handleListImports, handleDeleteAllImports, handleDeleteImport, handleCsvImport } from './routes/imports';
import { handleTillerImport } from './routes/tiller';
import { handleListRules, handleCreateRule, handleUpdateRule, handleDeleteRule, handleAutoCatImport } from './routes/rules';
import { handleAmazonImport } from './routes/amazon';
import {
  handleListBudgetCategories,
  handleCreateBudgetCategory,
  handleUpdateBudgetCategory,
  handleListBudgetTargets,
  handleUpsertBudgetTarget,
  handleDeleteBudgetTarget,
  handleBudgetStatus,
} from './routes/budget';
import { handlePnL, handlePnLAll, handlePnLTrend } from './routes/pnl';
import {
  handleBookkeepingSession,
  handleBookkeepingBatch,
  handleBookkeepingCommit,
  handleGetBookkeepingNotes,
  handleSaveBookkeepingNotes,
} from './routes/bookkeeping';
import { handleClaudeHealth } from './routes/health';

// MCP
import { handleMcp, type JsonRpcMessage } from './mcp-tools';

// Web UI (React SPA + cookie auth)
import { handleWebApi } from './web-api';
import { handleWebChat } from './web-chat';
import {
  requireApiAuth,
  requireWebSession,
  createSession,
  destroySession,
  setSessionCookieHeader,
  clearSessionCookieHeader,
  verifyPassword,
  loginHtml,
} from '@agentbuilder/web-ui-kit';

// SMS (Phase A — Twilio-backed categorization prompts)
import { handleSmsInbound } from './lib/sms-inbound';
import { runDispatch } from './lib/sms-dispatcher';
import {
  handleListSmsSettings,
  handleUpsertSmsSettings,
  handleDeleteSmsPerson,
  handleManualDispatch,
  handleSmsStats,
} from './routes/sms';

// Scheduled jobs
import { runNightlyTellerSync } from './lib/nightly-sync';

// The kit's auth helpers expect env.DB — which is exactly what the CFO
// has. This shim narrows env to the subset the kit reads, keeping the
// dependency explicit.
function kitEnv(env: Env): Record<string, unknown> {
  return {
    DB: env.DB,
    WEB_UI_PASSWORD: env.WEB_UI_PASSWORD,
    EXTERNAL_API_KEY: env.EXTERNAL_API_KEY,
  };
}

// Public favicon / web-app manifest paths. The Vite build copies the
// matching files from public/ into dist/ verbatim. Listed explicitly
// (rather than a prefix match) so we never accidentally bypass the auth
// gate for hashed asset paths or HTML routes.
const PUBLIC_ICON_PATHS = new Set<string>([
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-16.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/manifest.webmanifest',
]);

// Icon link tags injected into the kit's loginHtml so the login page
// (and any tab opened pre-auth) picks up the branded mark.
const ICON_HEAD = [
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png"/>',
  '<link rel="alternate icon" type="image/x-icon" href="/favicon.ico"/>',
  '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>',
  '<link rel="manifest" href="/manifest.webmanifest"/>',
  '<meta name="theme-color" content="#0F172A"/>',
  '<meta name="apple-mobile-web-app-title" content="CFO"/>',
  '<meta name="application-name" content="CFO"/>',
  '<meta name="apple-mobile-web-app-capable" content="yes"/>',
  '<meta name="mobile-web-app-capable" content="yes"/>',
].join('\n');

// ── Simple regex router ───────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, env: Env, ...params: any[]) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const ROUTES: Route[] = [
  // Health
  { method: 'GET',    pattern: /^\/health$/,                              handler: async () => Response.json({ status: 'ok', app: 'cfo' }) },
  { method: 'GET',    pattern: /^\/health\/claude$/,                       handler: (req, env) => handleClaudeHealth(req, env) },

  // Setup (entity + chart-of-accounts bootstrap, idempotent)
  { method: 'POST',   pattern: /^\/setup$/,                              handler: (req, env) => handleSetup(req, env) },

  // Bank provider abstraction (teller-only post-migration)
  { method: 'GET',    pattern: /^\/bank\/config$/,                       handler: (req, env) => handleGetBankConfig(req, env) },
  { method: 'POST',   pattern: /^\/bank\/connect\/start$/,               handler: (req, env) => handleStartBankConnect(req, env) },
  { method: 'POST',   pattern: /^\/bank\/connect\/complete$/,            handler: (req, env) => handleCompleteBankConnect(req, env) },
  { method: 'POST',   pattern: /^\/bank\/sync$/,                         handler: (req, env) => handleBankSync(req, env) },

  // Accounts
  { method: 'GET',    pattern: /^\/accounts$/,                           handler: (req, env) => handleListAccounts(req, env) },
  { method: 'PATCH',  pattern: /^\/accounts\/([^/]+)$/,                  handler: (req, env, id) => handleUpdateAccount(req, env, id) },

  // Transactions
  { method: 'GET',    pattern: /^\/transactions$/,                       handler: (req, env) => handleListTransactions(req, env) },
  { method: 'GET',    pattern: /^\/transactions\/([^/]+)$/,              handler: (req, env, id) => handleGetTransaction(req, env, id) },
  { method: 'DELETE', pattern: /^\/transactions\/([^/]+)$/,              handler: (req, env, id) => handleDeleteTransaction(req, env, id) },
  { method: 'PATCH',  pattern: /^\/transactions\/([^/]+)\/classify$/,    handler: (req, env, id) => handleManualClassify(req, env, id) },
  { method: 'POST',   pattern: /^\/transactions\/([^/]+)\/split$/,       handler: (req, env, id) => handleSplitTransaction(req, env, id) },

  // AI Classification
  { method: 'POST',   pattern: /^\/classify\/run$/,                      handler: (req, env) => handleRunClassification(req, env) },
  { method: 'POST',   pattern: /^\/classify\/reapply-account-rules$/,    handler: (req, env) => handleReapplyAccountRules(req, env) },
  { method: 'POST',   pattern: /^\/classify\/transaction\/([^/]+)$/,     handler: (req, env, id) => handleClassifySingle(req, env, id) },

  // Review queue
  { method: 'GET',    pattern: /^\/review$/,                             handler: (req, env) => handleListReview(req, env) },
  { method: 'GET',    pattern: /^\/review\/next$/,                       handler: (req, env) => handleNextReviewItem(req, env) },
  { method: 'PATCH',  pattern: /^\/review\/bulk$/,                       handler: (req, env) => handleBulkResolveReview(req, env) },
  { method: 'PATCH',  pattern: /^\/review\/([^/]+)$/,                    handler: (req, env, id) => handleResolveReview(req, env, id) },

  // Reports
  { method: 'GET',    pattern: /^\/reports\/schedule-c$/,                handler: (req, env) => handleScheduleC(req, env) },
  { method: 'GET',    pattern: /^\/reports\/schedule-e$/,                handler: (req, env) => handleScheduleE(req, env) },
  { method: 'GET',    pattern: /^\/reports\/summary$/,                   handler: (req, env) => handleSummary(req, env) },
  { method: 'GET',    pattern: /^\/reports\/export$/,                    handler: (req, env) => handleExport(req, env) },
  { method: 'POST',   pattern: /^\/reports\/snapshot$/,                  handler: (req, env) => handleSnapshot(req, env) },

  // Imports
  { method: 'GET',    pattern: /^\/imports$/,                            handler: (req, env) => handleListImports(req, env) },
  { method: 'DELETE', pattern: /^\/imports$/,                            handler: (req, env) => handleDeleteAllImports(req, env) },
  { method: 'DELETE', pattern: /^\/imports\/([^/]+)$/,                   handler: (req, env, id) => handleDeleteImport(req, env, id) },
  { method: 'POST',   pattern: /^\/imports\/csv$/,                       handler: (req, env) => handleCsvImport(req, env) },
  { method: 'POST',   pattern: /^\/imports\/amazon$/,                    handler: (req, env) => handleAmazonImport(req, env) },
  { method: 'POST',   pattern: /^\/imports\/tiller$/,                    handler: (req, env) => handleTillerImport(req, env) },

  // Budget
  { method: 'GET',    pattern: /^\/budget\/categories$/,                 handler: (req, env) => handleListBudgetCategories(req, env) },
  { method: 'POST',   pattern: /^\/budget\/categories$/,                 handler: (req, env) => handleCreateBudgetCategory(req, env) },
  { method: 'PATCH',  pattern: /^\/budget\/categories\/([^/]+)$/,        handler: (req, env, slug) => handleUpdateBudgetCategory(req, env, slug) },
  { method: 'GET',    pattern: /^\/budget\/targets$/,                    handler: (req, env) => handleListBudgetTargets(req, env) },
  { method: 'PUT',    pattern: /^\/budget\/targets$/,                    handler: (req, env) => handleUpsertBudgetTarget(req, env) },
  { method: 'DELETE', pattern: /^\/budget\/targets\/([^/]+)$/,           handler: (req, env, id) => handleDeleteBudgetTarget(req, env, id) },
  { method: 'GET',    pattern: /^\/budget\/status$/,                     handler: (req, env) => handleBudgetStatus(req, env) },

  // P&L / light bookkeeping
  { method: 'GET',    pattern: /^\/pnl$/,                                handler: (req, env) => handlePnL(req, env) },
  { method: 'GET',    pattern: /^\/pnl\/all$/,                           handler: (req, env) => handlePnLAll(req, env) },
  { method: 'GET',    pattern: /^\/pnl\/trend$/,                         handler: (req, env) => handlePnLTrend(req, env) },

  // Bookkeeping sessions
  { method: 'GET',    pattern: /^\/bookkeeping\/session$/,               handler: (req, env) => handleBookkeepingSession(req, env) },
  { method: 'GET',    pattern: /^\/bookkeeping\/batch$/,                 handler: (req, env) => handleBookkeepingBatch(req, env) },
  { method: 'POST',   pattern: /^\/bookkeeping\/commit$/,                handler: (req, env) => handleBookkeepingCommit(req, env) },
  { method: 'GET',    pattern: /^\/bookkeeping\/notes$/,                 handler: (req, env) => handleGetBookkeepingNotes(req, env) },
  { method: 'PUT',    pattern: /^\/bookkeeping\/notes$/,                 handler: (req, env) => handleSaveBookkeepingNotes(req, env) },

  // Cron triggers — manual entry points for testing/debugging the scheduled handler
  { method: 'POST',   pattern: /^\/cron\/nightly-sync$/,                 handler: async (_req, env) => Response.json(await runNightlyTellerSync(env)) },
  { method: 'POST',   pattern: /^\/cron\/sms\/dispatch$/,                handler: (req, env) => handleManualDispatch(req, env) },

  // Rules
  { method: 'GET',    pattern: /^\/rules$/,                              handler: (req, env) => handleListRules(req, env) },
  { method: 'POST',   pattern: /^\/rules$/,                              handler: (req, env) => handleCreateRule(req, env) },
  { method: 'POST',   pattern: /^\/rules\/import-autocat$/,              handler: (req, env) => handleAutoCatImport(req, env) },
  { method: 'PUT',    pattern: /^\/rules\/([^/]+)$/,                     handler: (req, env, id) => handleUpdateRule(req, env, id) },
  { method: 'DELETE', pattern: /^\/rules\/([^/]+)$/,                     handler: (req, env, id) => handleDeleteRule(req, env, id) },
];

// ── /mcp auth ─────────────────────────────────────────────────────────────────

function requireMcpAuth(
  request: Request,
  env: Env,
): { ok: true } | { ok: false; response: Response } {
  const expected = env.MCP_HTTP_KEY ?? '';
  if (!expected) return { ok: true };

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? new URL(request.url).searchParams.get('key') ?? '';

  if (token && token === expected) return { ok: true };
  return { ok: false, response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
}

// ── Worker ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, Authorization',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ── Public favicon / web-app manifest passthrough ─────────────────────
    // Browsers fetch these BEFORE the user logs in (the login page itself
    // links to them, and MacOS Chrome's "Install as App" needs the icons
    // to resolve unauthenticated). The Vite build copies public/*.{ico,
    // svg,png,webmanifest} into dist/ verbatim — see apps/cfo/scripts/
    // gen-icons.py for how they're generated.
    if (method === 'GET' && PUBLIC_ICON_PATHS.has(path)) {
      return env.ASSETS.fetch(request);
    }

    // ── Web UI auth (kit cookie session) ──────────────────────────────────
    // Pattern mirrors research-agent's /lab/* surface so the same tooling
    // (loginHtml, requireWebSession, requireApiAuth) is shared.
    if (path === '/login' && method === 'GET') {
      return new Response(loginHtml({ title: 'CFO', action: '/login', head: ICON_HEAD }), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/login' && method === 'POST') {
      if (!env.WEB_UI_PASSWORD) {
        return new Response(loginHtml({ title: 'CFO', action: '/login', head: ICON_HEAD, error: 'WEB_UI_PASSWORD is not configured.' }), {
          status: 500, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const form = await request.formData().catch(() => null);
      const password = form?.get?.('password') || '';
      if (!verifyPassword(kitEnv(env), password)) {
        return new Response(loginHtml({ title: 'CFO', action: '/login', head: ICON_HEAD, error: 'Wrong password.' }), {
          status: 401, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      const { sessionId } = await createSession(kitEnv(env));
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
      const session = await requireWebSession(request, kitEnv(env), { mode: 'page' });
      if (session.ok) await destroySession(kitEnv(env), session.sessionId);
      const secure = url.protocol === 'https:';
      return new Response(null, {
        status: 302,
        headers: {
          location: '/login',
          'set-cookie': clearSessionCookieHeader({ secure }),
        },
      });
    }

    // ── Twilio inbound webhook (signature-verified, no cookie auth) ───────
    // Twilio doesn't carry cookies. /sms/inbound verifies X-Twilio-Signature
    // with TWILIO_AUTH_TOKEN; everything else is rejected with 403.
    if (path === '/sms/inbound' && method === 'POST') {
      return handleSmsInbound(request, env);
    }

    // ── /api/web/* — JSON API for the React SPA ───────────────────────────
    if (path.startsWith('/api/web/')) {
      const auth = await requireApiAuth(request, kitEnv(env));
      if (!auth.ok) return auth.response;

      if (path === '/api/web/chat' && method === 'POST') {
        return handleWebChat(request, env, /* ctx */ {} as ExecutionContext);
      }
      // SMS settings live under /api/web/sms/*
      if (path === '/api/web/sms/settings' && method === 'GET') {
        return handleListSmsSettings(request, env);
      }
      if (path === '/api/web/sms/settings' && method === 'PUT') {
        return handleUpsertSmsSettings(request, env);
      }
      const smsPersonMatch = path.match(/^\/api\/web\/sms\/settings\/([^/]+)$/);
      if (smsPersonMatch && method === 'DELETE') {
        return handleDeleteSmsPerson(request, env, smsPersonMatch[1]!);
      }
      if (path === '/api/web/sms/stats' && method === 'GET') {
        return handleSmsStats(request, env);
      }
      const webResponse = await handleWebApi(request, env);
      if (webResponse) return webResponse;
      return Response.json({ error: `Not found: ${method} ${path}` }, { status: 404 });
    }

    // MCP /mcp for Claude custom tool integration
    if (path === '/mcp' && request.method === 'POST') {
      const auth = requireMcpAuth(request, env);
      if (!auth.ok) return auth.response;

      let msg: JsonRpcMessage;
      try {
        msg = (await request.json()) as JsonRpcMessage;
      } catch {
        return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
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

    // REST routes — matched by method + regex
    for (const route of ROUTES) {
      if (route.method !== request.method) continue;
      const match = path.match(route.pattern);
      if (match) {
        try {
          const params = match.slice(1).map(p => p ?? '') as string[];
          const response = await route.handler(request, env, ...params);
          response.headers.set('Access-Control-Allow-Origin', '*');
          return response;
        } catch (err) {
          console.error(`Error in ${request.method} ${path}:`, err);
          return jsonError(`Internal server error: ${String(err)}`, 500);
        }
      }
    }

    // ── Legacy tax-prep SPA at /legacy (cookie-gated) ─────────────────────
    // The pre-rewrite SPA still exists at public/legacy.html and uses
    // header auth (X-User-Id) for its API calls. We gate the bundle
    // behind the kit's web session so the page itself isn't public.
    if ((path === '/legacy' || path === '/legacy/') && request.method === 'GET') {
      const session = await requireWebSession(request, kitEnv(env), { mode: 'page' });
      if (!session.ok) return session.response;
      return env.ASSETS.fetch(new Request(new URL('/legacy.html', request.url).toString(), request));
    }

    // ── New React SPA at / (cookie-gated) ─────────────────────────────────
    // Vite-built bundle lives under dist/ and is served by the [assets]
    // binding. Any unmatched GET falls through to the SPA so client-side
    // routing works.
    if (request.method === 'GET') {
      const session = await requireWebSession(request, kitEnv(env), { mode: 'page' });
      if (!session.ok) return session.response;
      // Hashed asset paths (/assets/index-abc.js etc.) — let ASSETS
      // resolve them directly. Anything else is the SPA shell.
      if (path.startsWith('/assets/')) {
        return env.ASSETS.fetch(request);
      }
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString(), request));
    }

    return jsonError('Not found', 404);
  },

  // Cloudflare Cron Trigger entrypoint. We dispatch by cron expression:
  //   "0 9 * * *"        → nightly Teller sync
  //   "*/30 * * * *"     → SMS dispatcher (it self-checks Pacific local
  //                        time + per-person preferred slots, so 47 of
  //                        the 48 daily fires are no-ops).
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === '0 9 * * *') {
      ctx.waitUntil(
        runCron(
          env,
          { agentId: 'cfo', trigger: 'nightly-sync', cron: event.cron },
          () => runNightlyTellerSync(env),
        ),
      );
      return;
    }

    if (event.cron === '*/30 * * * *') {
      ctx.waitUntil(
        runCron(
          env,
          { agentId: 'cfo', trigger: 'sms-dispatch', cron: event.cron },
          () => runDispatch(env),
        ),
      );
      return;
    }

    console.warn('[scheduled] unknown cron expression', event.cron);
  },
} satisfies ExportedHandler<Env>;
