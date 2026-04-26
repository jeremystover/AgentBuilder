/**
 * web-api.ts — JSON endpoints for the React SPA at /.
 *
 * Routes (all prefixed /api/web):
 *
 *   GET  /api/web/snapshot   — consolidated P&L + budget + review-queue
 *                              count for the dashboard right rail
 *
 * Auth: index.ts gates everything under /api/web/* with the kit's
 * requireApiAuth (cookie session OR EXTERNAL_API_KEY bearer). Handlers
 * here trust the caller and just do the work.
 *
 * Multi-tenancy: the underlying REST handlers identify users via the
 * X-User-Id header (legacy tax-prep convention). Web sessions don't
 * carry a user id, so we pin to env.WEB_UI_USER_ID (default "default").
 * One user per worker for now — multi-user comes when the kit grows
 * proper user accounts.
 */

import type { Env } from './types';
import { handlePnLAll } from './routes/pnl';
import { handleBudgetStatus } from './routes/budget';

function webUserId(env: Env): string {
  return env.WEB_UI_USER_ID ?? 'default';
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Re-issue an internal request to a REST handler with X-User-Id baked
 * in from the configured WEB_UI_USER_ID. This avoids re-implementing
 * SQL we already have, at the cost of one extra Request construction.
 */
function internalRequest(env: Env, originalUrl: URL, search: string): Request {
  const url = new URL(originalUrl.toString());
  url.search = search;
  return new Request(url.toString(), {
    method: 'GET',
    headers: { 'x-user-id': webUserId(env) },
  });
}

interface PnlAllResponse {
  period: { start: string; end: string; days: number; label: string };
  entities: Array<{
    entity: string;
    income: { total: number };
    expenses: { total: number };
    net_income: number;
  }>;
  consolidated: { income: number; expenses: number; net_income: number };
}

interface BudgetStatusResponse {
  period: { start: string; end: string; days: number; label: string };
  categories: Array<{
    category_slug: string;
    category_name: string;
    spent: number;
    target: { prorated_amount: number } | null;
    percent_used: number | null;
  }>;
}

// ── GET /api/web/snapshot ──────────────────────────────────────────────────

async function handleSnapshot(request: Request, env: Env): Promise<Response> {
  const userId = webUserId(env);
  const url = new URL(request.url);

  // P&L for this month, all entities consolidated.
  let pnl: PnlAllResponse | null = null;
  try {
    const res = await handlePnLAll(internalRequest(env, url, 'preset=this_month'), env);
    if (res.ok) pnl = (await res.json()) as PnlAllResponse;
  } catch (err) {
    console.error('[snapshot] pnl failed', err);
  }

  // Budget status for this month.
  let budget: BudgetStatusResponse | null = null;
  try {
    const res = await handleBudgetStatus(internalRequest(env, url, 'preset=this_month'), env);
    if (res.ok) budget = (await res.json()) as BudgetStatusResponse;
  } catch (err) {
    console.error('[snapshot] budget failed', err);
  }

  // Review-queue count — direct DB query, cheaper than hydrating /review.
  let reviewQueueCount = 0;
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt
       FROM review_queue
       WHERE user_id = ? AND resolved_at IS NULL`,
    ).bind(userId).first<{ cnt: number }>();
    reviewQueueCount = row?.cnt ?? 0;
  } catch (err) {
    // Table may not exist in fresh dev DBs — treat as zero.
    console.error('[snapshot] review_queue count failed', err);
  }

  // Tax year — best-effort lookup against the user's active workflow.
  let taxYear: number | null = null;
  try {
    const row = await env.DB.prepare(
      `SELECT tax_year FROM tax_year_workflow
       WHERE user_id = ?
       ORDER BY tax_year DESC
       LIMIT 1`,
    ).bind(userId).first<{ tax_year: number }>();
    taxYear = row?.tax_year ?? null;
  } catch {
    // Table may not exist yet.
  }

  return jsonResponse({
    tax_year: taxYear,
    pnl: pnl
      ? {
          period_label: pnl.period.label,
          entities: pnl.entities.map((e) => ({
            entity: e.entity,
            income: e.income.total,
            expense: e.expenses.total,
            net: e.net_income,
          })),
          consolidated: {
            income: pnl.consolidated.income,
            expense: pnl.consolidated.expenses,
            net: pnl.consolidated.net_income,
          },
        }
      : null,
    budget: budget
      ? {
          period_label: budget.period.label,
          lines: budget.categories
            .filter((c) => c.target !== null)
            .map((c) => ({
              category_slug: c.category_slug,
              category_name: c.category_name,
              spent: c.spent,
              target: c.target?.prorated_amount ?? 0,
              pct: c.percent_used != null ? c.percent_used / 100 : 0,
            })),
        }
      : null,
    review_queue_count: reviewQueueCount,
  });
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export async function handleWebApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/web/snapshot' && method === 'GET') {
    return handleSnapshot(request, env);
  }

  return null;
}
