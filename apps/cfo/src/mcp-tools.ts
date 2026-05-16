/**
 * MCP JSON-RPC 2.0 surface for the cfo worker.
 *
 * Thin wrapper over the /api/web/* REST surface: each tool call builds a
 * synthetic Request and forwards to the existing route handler. Same
 * behavior as the SPA — no parallel business logic.
 *
 * 10 tools total (AGENTS.md rule 2). The same names go in the in-app
 * chat allowlist (web-chat-tools.ts).
 */

import type { Env } from './types';
import {
  handleListReview, handleUpdateReview, handleApproveReview, handleBulkReview,
  handleReviewNext, handleReviewStatus,
} from './routes/web-review';
import { handleListTransactions } from './routes/web-transactions';
import { handleSpendingReport } from './routes/spending';
import { handleListPlans, handleForecastPlan } from './routes/planning';
import { handleListAccounts } from './routes/web-lookups';
import { handleListRules, handleCreateRule } from './routes/web-rules';
import { runTellerSync } from './routes/teller';
import { runEmailSync } from './lib/email-sync';
import { backfillEmailEnrichment } from './lib/transaction-split';
import type { VendorHint } from './lib/email-matchers/match';
import { handleListReportConfigs, handleGenerateReport } from './routes/reports';
import { db } from './lib/db';

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const MCP_TOOLS = [
  {
    name: 'review_status',
    description:
      'Quick overview of the review queue: how many transactions are pending, held, or recently approved. Use at the start of a bookkeeping session to understand what needs attention.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'review_next',
    description:
      'Get the next transaction pending human review, with AI reasoning, matched rules, and similar past transactions for context. Returns one transaction at a time for interview-mode review. Use repeatedly to work through the queue.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_slug: { type: 'string' as const, description: 'Filter to a specific entity slug.' },
        min_confidence: { type: 'number' as const, description: 'Only return rows with AI confidence below this threshold (e.g. 0.7 to focus on uncertain ones).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'review_resolve',
    description:
      "Accept or reclassify a pending transaction. Use 'accept' to approve the AI's suggestion as-is, or provide entity_slug and category_slug to reclassify before approving. 'skip' leaves the row pending. 'mark_transfer' / 'mark_reimbursable' toggle those flags without approving.",
    inputSchema: {
      type: 'object' as const,
      required: ['transaction_id', 'action'],
      properties: {
        transaction_id: { type: 'string' as const },
        action: { type: 'string' as const, enum: ['accept', 'reclassify', 'skip', 'mark_transfer', 'mark_reimbursable'] },
        entity_slug: { type: 'string' as const },
        category_slug: { type: 'string' as const },
        note: { type: 'string' as const, description: 'Optional note saved to human_notes.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'review_bulk_accept',
    description:
      'Approve all pending transactions matching a filter in one operation. Use for high-confidence batches (e.g. all rule-matched transactions, or all transactions from a specific date range).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        method:         { type: 'string' as const, enum: ['rule', 'ai'], description: 'Accept only rule-matched or AI-classified transactions.' },
        min_confidence: { type: 'number' as const, description: 'Accept only transactions at or above this AI confidence (0–1).' },
        entity_slug:    { type: 'string' as const },
        date_from:      { type: 'string' as const },
        date_to:        { type: 'string' as const },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'transactions_list',
    description:
      "Search and filter approved transactions. Use for questions like 'show me all Costco charges this year' or 'what did we spend on dining in Q1'.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        q:             { type: 'string' as const, description: 'Search term for description or merchant.' },
        entity_slug:   { type: 'string' as const },
        category_slug: { type: 'string' as const },
        date_from:     { type: 'string' as const },
        date_to:       { type: 'string' as const },
        limit:         { type: 'number' as const, default: 25 },
        offset:        { type: 'number' as const, default: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'spending_summary',
    description:
      "Show spending vs. plan for a time period. Returns category-level actuals, planned amounts, and over/under deltas. Good for 'how are we tracking against budget this month' questions.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        period:         { type: 'string' as const, enum: ['this_month', 'last_month', 'this_quarter', 'ytd', 'custom'] },
        date_from:      { type: 'string' as const, description: 'Required if period=custom.' },
        date_to:        { type: 'string' as const, description: 'Required if period=custom.' },
        entity_slug:    { type: 'string' as const },
        category_slugs: { type: 'array' as const, items: { type: 'string' as const } },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rules_list',
    description:
      'List active classification rules. Shows what patterns are being auto-classified and how many transactions each rule has matched.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity_slug: { type: 'string' as const },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rules_create',
    description:
      'Create a new classification rule. Applied to all FUTURE transactions matching the criteria. Use after the user corrects a misclassification that is likely to recur.',
    inputSchema: {
      type: 'object' as const,
      required: ['name', 'entity_slug', 'category_slug'],
      properties: {
        name:                    { type: 'string' as const },
        description_contains:    { type: 'string' as const },
        description_starts_with: { type: 'string' as const },
        amount_min:              { type: 'number' as const },
        amount_max:              { type: 'number' as const },
        entity_slug:             { type: 'string' as const },
        category_slug:           { type: 'string' as const },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'accounts_list',
    description: 'List all configured accounts with their current sync status, last sync time, and entity assignment.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'sync_run',
    description:
      "Trigger a manual sync for Teller accounts and/or email sources. Use when the user wants current data before a review session.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        sources: {
          type: 'array' as const,
          items: { type: 'string' as const, enum: ['teller', 'email_amazon', 'email_venmo', 'email_apple', 'email_etsy', 'all'] },
          description: "Which sources to sync. Omit or use ['all'] to sync everything.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'email_enrichment_backfill',
    description:
      'One-time: re-apply email enrichment to already-matched review-queue transactions — split multi-item Apple receipts into per-item rows and rewrite Apple/Venmo descriptions to the item name / payment memo.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'report_list_configs',
    description:
      'List available report configurations (Schedule C, Schedule E, family summary, etc.) with their IDs and last run dates.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'plan_list',
    description:
      'List all financial plans with their type (foundation/modification), status, and whether they are the active plan used for budget comparison.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'plan_forecast',
    description:
      "Show the cash flow forecast from the active plan: expected income, expenses, and net for each month or year going forward. Good for 'what does our budget look like for the rest of the year' questions.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        months_ahead: { type: 'number' as const, default: 12, description: 'How many months to forecast.' },
        period_type:  { type: 'string' as const, enum: ['monthly', 'annual'], default: 'monthly' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'report_generate',
    description:
      'Generate a financial report for a config and date range. Returns a Google Drive link to the spreadsheet. Use for Schedule C, Schedule E, or spending summaries. Call report_list_configs first to get config IDs.',
    inputSchema: {
      type: 'object' as const,
      required: ['config_id', 'period'],
      properties: {
        config_id: { type: 'string' as const },
        period:    { type: 'string' as const, enum: ['last_month', 'last_quarter', 'last_year', 'ytd', 'custom'] },
        date_from: { type: 'string' as const, description: 'Required if period=custom.' },
        date_to:   { type: 'string' as const, description: 'Required if period=custom.' },
      },
      additionalProperties: false,
    },
  },
] as const;

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function handleMcp(message: JsonRpcMessage, env: Env): Promise<unknown> {
  const { id, method, params } = message;

  if (!method) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cfo', version: '0.1.0' },
        instructions:
          'Family finance agent: transaction review, spending analysis, and sync management. ' +
          'Four entities: Elyse Coaching (Schedule C), Jeremy Coaching (Schedule C), Whitford House (Schedule E), Personal/Family. ' +
          'Data from Teller bank sync + Gmail email enrichment (Amazon, Venmo, Apple, Etsy). ' +
          'Start a session with review_status to see what needs attention.',
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }
  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await dispatchTool(name, args, env);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { jsonrpc: '2.0', id, error: { code: -32000, message: errorMessage } };
    }
  }
  if (method === 'notifications/initialized') return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Per-tool dispatch ────────────────────────────────────────────────────────

export async function dispatchTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    case 'review_status':
      return respondText(await handleReviewStatus(getReq('https://cfo.invalid/api/web/review/status'), env));

    case 'review_next': {
      const url = withQuery('https://cfo.invalid/api/web/review/next', args);
      return respondText(await handleReviewNext(getReq(url), env));
    }

    case 'review_resolve':
      return resolveReview(args, env);

    case 'review_bulk_accept':
      return bulkAccept(args, env);

    case 'transactions_list': {
      const url = withQuery('https://cfo.invalid/api/web/transactions', await translateEntityAndCategorySlugs(env, {
        q: args.q,
        entity_id: await slugToEntityId(env, args.entity_slug),
        category_id: await slugToCategoryId(env, args.category_slug),
        date_from: args.date_from,
        date_to: args.date_to,
        limit: args.limit,
        offset: args.offset,
      }));
      return respondText(await handleListTransactions(getReq(url), env));
    }

    case 'spending_summary':
      return spendingSummary(args, env);

    case 'rules_list':
      return respondText(await handleListRules(getReq('https://cfo.invalid/api/web/rules'), env));

    case 'rules_create':
      return createRule(args, env);

    case 'accounts_list':
      return respondText(await handleListAccounts(getReq('https://cfo.invalid/api/web/accounts'), env));

    case 'sync_run':
      return syncRun(args, env);

    case 'email_enrichment_backfill':
      return JSON.stringify(await backfillEmailEnrichment(env));

    case 'plan_list':
      return respondText(await handleListPlans(getReq('https://cfo.invalid/api/web/plans'), env));

    case 'plan_forecast':
      return planForecast(args, env);

    case 'report_list_configs':
      return respondText(await handleListReportConfigs(getReq('https://cfo.invalid/api/web/reports/configs'), env));

    case 'report_generate': {
      const configId = String(args.config_id ?? '');
      if (!configId) throw new Error('config_id is required');
      const body: Record<string, unknown> = { period: args.period };
      if (typeof args.date_from === 'string') body.date_from = args.date_from;
      if (typeof args.date_to === 'string') body.date_to = args.date_to;
      const req = postReq(`https://cfo.invalid/api/web/reports/configs/${configId}/generate`, body);
      return respondText(await handleGenerateReport(req, env, configId));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool-specific helpers ────────────────────────────────────────────────────

async function resolveReview(args: Record<string, unknown>, env: Env): Promise<string> {
  const transactionId = String(args.transaction_id ?? '');
  const action = String(args.action ?? '');
  if (!transactionId || !action) throw new Error('transaction_id and action are required');

  const entityId = await slugToEntityId(env, args.entity_slug);
  const categoryId = await slugToCategoryId(env, args.category_slug);
  const note = typeof args.note === 'string' ? args.note : undefined;

  // First persist any edits from the call.
  const updateBody: Record<string, unknown> = {};
  if (entityId) updateBody.entity_id = entityId;
  if (categoryId) updateBody.category_id = categoryId;
  if (note) updateBody.human_notes = note;
  if (action === 'mark_transfer') updateBody.is_transfer = true;
  if (action === 'mark_reimbursable') updateBody.is_reimbursable = true;

  if (Object.keys(updateBody).length > 0) {
    const req = postReq(`https://cfo.invalid/api/web/review/${transactionId}`, updateBody, 'PUT');
    const resp = await handleUpdateReview(req, env, transactionId);
    if (!resp.ok) return respondText(resp);
  }

  if (action === 'skip') return JSON.stringify({ skipped: transactionId });
  if (action === 'mark_transfer' || action === 'mark_reimbursable') {
    return JSON.stringify({ flagged: transactionId, action });
  }

  // 'accept' and 'reclassify' both approve the row (any edits already persisted).
  const approveResp = await handleApproveReview(getReq(`https://cfo.invalid/api/web/review/${transactionId}/approve`), env, transactionId);
  return respondText(approveResp);
}

async function bulkAccept(args: Record<string, unknown>, env: Env): Promise<string> {
  // Build filters that handleBulkReview understands. We post action=approve
  // with apply_to_filtered=true and a filters dict that mirrors the GET
  // /api/web/review query-string.
  const filters: Record<string, string | string[]> = { status: 'staged' };
  if (typeof args.date_from === 'string') filters.date_from = args.date_from;
  if (typeof args.date_to === 'string') filters.date_to = args.date_to;
  if (typeof args.entity_slug === 'string') {
    const eid = await slugToEntityId(env, args.entity_slug);
    if (eid) filters.entity_id = eid;
  }
  if (args.method === 'rule') filters.confidence = 'rule';
  if (typeof args.min_confidence === 'number' && args.min_confidence >= 0.9) filters.confidence = 'high';
  else if (typeof args.min_confidence === 'number' && args.min_confidence >= 0.7) filters.confidence = 'medium';

  const body = {
    action: 'approve' as const,
    apply_to_filtered: true,
    filters,
  };
  const req = postReq('https://cfo.invalid/api/web/review/bulk', body);
  return respondText(await handleBulkReview(req, env));
}

async function createRule(args: Record<string, unknown>, env: Env): Promise<string> {
  const entityId = await slugToEntityId(env, args.entity_slug);
  const categoryId = await slugToCategoryId(env, args.category_slug);
  if (!entityId) throw new Error(`Unknown entity_slug: ${args.entity_slug}`);
  if (!categoryId) throw new Error(`Unknown category_slug: ${args.category_slug}`);
  const match_json: Record<string, unknown> = {};
  if (typeof args.description_contains === 'string') match_json.description_contains = args.description_contains;
  if (typeof args.description_starts_with === 'string') match_json.description_starts_with = args.description_starts_with;
  if (typeof args.amount_min === 'number') match_json.amount_min = args.amount_min;
  if (typeof args.amount_max === 'number') match_json.amount_max = args.amount_max;
  if (Object.keys(match_json).length === 0) throw new Error('At least one match field is required');

  const body = {
    name: String(args.name ?? ''),
    match_json,
    entity_id: entityId,
    category_id: categoryId,
    created_by: 'user' as const,
  };
  return respondText(await handleCreateRule(postReq('https://cfo.invalid/api/web/rules', body), env));
}

async function spendingSummary(args: Record<string, unknown>, env: Env): Promise<string> {
  const period = typeof args.period === 'string' ? args.period : 'this_month';
  const customFrom = typeof args.date_from === 'string' ? args.date_from : undefined;
  const customTo   = typeof args.date_to   === 'string' ? args.date_to   : undefined;
  const { from, to } = resolveSpendingPeriod(period, customFrom, customTo);

  const entityId = await slugToEntityId(env, args.entity_slug);
  const categoryIds: string[] = [];
  if (Array.isArray(args.category_slugs)) {
    for (const slug of args.category_slugs) {
      const id = await slugToCategoryId(env, slug);
      if (id) categoryIds.push(id);
    }
  }

  // Use the active plan as the default comparison plan.
  const sql = db(env);
  let activePlanId: string | null = null;
  try {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM plans WHERE is_active = true LIMIT 1
    `;
    activePlanId = rows[0]?.id ?? null;
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }

  const params: Record<string, unknown> = {
    date_from: from, date_to: to,
    period_type: 'monthly',
  };
  if (activePlanId) params.plan_ids = activePlanId;
  if (entityId) params.entity_ids = entityId;
  if (categoryIds.length > 0) params.category_ids = categoryIds.join(',');

  const url = withQuery('https://cfo.invalid/api/web/spending/report', params);
  return respondText(await handleSpendingReport(getReq(url), env));
}

function resolveSpendingPeriod(
  period: string,
  customFrom?: string,
  customTo?: string,
): { from: string; to: string } {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const yr = today.getUTCFullYear();
  const mo = today.getUTCMonth();
  switch (period) {
    case 'this_month':
      return { from: iso(new Date(Date.UTC(yr, mo, 1))), to: iso(today) };
    case 'last_month':
      return {
        from: iso(new Date(Date.UTC(yr, mo - 1, 1))),
        to:   iso(new Date(Date.UTC(yr, mo, 0))),
      };
    case 'this_quarter': {
      const qStart = Math.floor(mo / 3) * 3;
      return { from: iso(new Date(Date.UTC(yr, qStart, 1))), to: iso(today) };
    }
    case 'ytd':
      return { from: `${yr}-01-01`, to: iso(today) };
    case 'custom':
      return { from: customFrom ?? `${yr}-01-01`, to: customTo ?? iso(today) };
    default:
      return { from: iso(new Date(Date.UTC(yr, mo, 1))), to: iso(today) };
  }
}

async function planForecast(args: Record<string, unknown>, env: Env): Promise<string> {
  const sql = db(env);
  let activeId: string | null = null;
  try {
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM plans WHERE is_active = true LIMIT 1`;
    activeId = rows[0]?.id ?? null;
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
  if (!activeId) return JSON.stringify({ error: 'No active plan set. Create a plan and mark it active first.' });
  const monthsAhead = typeof args.months_ahead === 'number' ? args.months_ahead : 12;
  const periodType  = args.period_type === 'annual' ? 'annual' : 'monthly';
  const url = withQuery(`https://cfo.invalid/api/web/plans/${activeId}/forecast`, {
    horizon_months: monthsAhead, period_type: periodType,
  });
  return respondText(await handleForecastPlan(getReq(url), env, activeId));
}

async function syncRun(args: Record<string, unknown>, env: Env): Promise<string> {
  const sources = Array.isArray(args.sources) ? args.sources : ['all'];
  const targets = sources.includes('all')
    ? ['teller', 'email_amazon', 'email_venmo', 'email_apple', 'email_etsy']
    : sources;
  const results: Array<{ source: string; result: unknown }> = [];
  for (const s of targets) {
    const source = typeof s === 'string' ? s : '';
    if (!source) continue;
    try {
      if (source === 'teller') {
        const out = await runTellerSync(env);
        results.push({ source, result: out });
      } else if (source.startsWith('email_')) {
        const vendor = source.slice('email_'.length) as VendorHint;
        const out = await runEmailSync(env, [vendor]);
        results.push({ source, result: out });
      }
    } catch (err) {
      results.push({ source, result: { error: err instanceof Error ? err.message : String(err) } });
    }
  }
  return JSON.stringify({ syncs: results });
}

// ── Slug → id lookups (small, cached per dispatch) ──────────────────────────

async function slugToEntityId(env: Env, slug: unknown): Promise<string | undefined> {
  if (typeof slug !== 'string' || !slug) return undefined;
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM entities WHERE slug = ${slug} LIMIT 1`;
    return rows[0]?.id;
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
}

async function slugToCategoryId(env: Env, slug: unknown): Promise<string | undefined> {
  if (typeof slug !== 'string' || !slug) return undefined;
  const sql = db(env);
  try {
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM categories WHERE slug = ${slug} LIMIT 1`;
    return rows[0]?.id;
  } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
}

async function translateEntityAndCategorySlugs(_env: Env, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Already resolved in callers; pass through. Wrapper kept for clarity.
  return params;
}

// ── HTTP helpers (mirrors old CFO pattern) ───────────────────────────────────

function getReq(url: string): Request {
  return new Request(url, { method: 'GET', headers: { 'content-type': 'application/json' } });
}

function postReq(url: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function withQuery(base: string, args: Record<string, unknown>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function respondText(res: Response): Promise<string> {
  return res.text();
}
