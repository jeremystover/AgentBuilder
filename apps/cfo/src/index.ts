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

import type { Env } from './types';
import { jsonError } from './types';

// Routes
import { handleSetup } from './routes/setup';
import { handleGetBankConfig, handleStartBankConnect, handleCompleteBankConnect, handleBankSync } from './routes/bank';
import { handleListAccounts, handleUpdateAccount } from './routes/accounts';
import { handleListTransactions, handleGetTransaction, handleDeleteTransaction, handleManualClassify, handleSplitTransaction } from './routes/transactions';
import { handleRunClassification, handleClassifySingle } from './routes/classify';
import { handleListReview, handleResolveReview, handleBulkResolveReview } from './routes/review';
import { handleScheduleC, handleScheduleE, handleSummary, handleExport, handleSnapshot } from './routes/reports';
import { handleListImports, handleDeleteAllImports, handleDeleteImport, handleCsvImport } from './routes/imports';
import { handleTillerImport } from './routes/tiller';
import { handleListRules, handleCreateRule, handleUpdateRule, handleDeleteRule, handleAutoCatImport } from './routes/rules';
import { handleAmazonImport } from './routes/amazon';
import { handleCreateTaxYearWorkflow, handleGetTaxYearWorkflow } from './routes/workflow';
import { handleClaudeHealth } from './routes/health';

// MCP
import { handleMcp, type JsonRpcMessage } from './mcp-tools';

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

  // Setup
  { method: 'POST',   pattern: /^\/setup$/,                              handler: (req, env) => handleSetup(req, env) },
  { method: 'GET',    pattern: /^\/workflow\/tax-year$/,                 handler: (req, env) => handleGetTaxYearWorkflow(req, env) },
  { method: 'POST',   pattern: /^\/workflow\/tax-year$/,                 handler: (req, env) => handleCreateTaxYearWorkflow(req, env) },

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
  { method: 'POST',   pattern: /^\/classify\/transaction\/([^/]+)$/,     handler: (req, env, id) => handleClassifySingle(req, env, id) },

  // Review queue
  { method: 'GET',    pattern: /^\/review$/,                             handler: (req, env) => handleListReview(req, env) },
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

    // Serve the SPA for any unmatched GET (client-side routing via hash).
    if (request.method === 'GET') {
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url).toString(), request));
    }

    return jsonError('Not found', 404);
  },
} satisfies ExportedHandler<Env>;
