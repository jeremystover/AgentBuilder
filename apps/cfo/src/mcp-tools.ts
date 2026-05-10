/**
 * MCP JSON-RPC 2.0 handler for the CFO worker.
 *
 * The strategy here is "thin wrapper over REST": every MCP tool invokes
 * the same route handler the SPA already uses, by synthesizing a Request
 * with the right method, path, headers, and body. This keeps the two
 * surfaces in sync — any bug fix in the REST layer shows up in MCP for
 * free, and we don't have parallel implementations to drift apart.
 *
 * Tool surface (initial — tracks the CFO registry entry):
 *   - teller_sync: POST /bank/sync
 *   - csv_import: POST /imports/csv
 *   - amazon_import: POST /imports/amazon
 *   - tiller_import: POST /imports/tiller
 *   - classify_transactions: POST /classify/run
 *   - list_review_queue: GET /review
 *   - resolve_review: PATCH /review/:id
 *   - schedule_c_report: GET /reports/schedule-c
 *   - schedule_e_report: GET /reports/schedule-e
 *   - transactions_summary: GET /reports/summary
 *
 * Adding a new MCP tool later = add an entry to MCP_TOOLS and a case in
 * dispatchTool. Do NOT add new business logic here — extend the REST
 * handler and proxy to it.
 */

import type { Env } from './types';
import { handleUpdateAccount } from './routes/accounts';
import { handleBankSync } from './routes/bank';
import { handleCsvImport } from './routes/imports';
import { handleAmazonImport } from './routes/amazon';
import { handleTillerImport } from './routes/tiller';
import { handleRunClassification, handleReapplyAccountRules } from './routes/classify';
import { handleListReview, handleResolveReview, handleNextReviewItem } from './routes/review';
import { handleScheduleC, handleScheduleE, handleSummary } from './routes/reports';
import {
  handleListBudgetCategories,
  handleCreateBudgetCategory,
  handleUpsertBudgetTarget,
  handleBudgetStatus,
  handleBudgetForecast,
  handleBudgetCutsReport,
} from './routes/budget';
import { handlePnL, handlePnLAll, handlePnLTrend } from './routes/pnl';
import {
  handleBookkeepingSession,
  handleBookkeepingBatch,
  handleBookkeepingCommit,
  handleGetBookkeepingNotes,
  handleSaveBookkeepingNotes,
} from './routes/bookkeeping';

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

// ── Tool catalog ──────────────────────────────────────────────────────────────

export const MCP_TOOLS = [
  {
    name: 'teller_sync',
    description:
      "Sync the latest transactions from the user's Teller-connected bank accounts into the CFO database for the current tax-year workflow. Returns a summary of accounts synced and transactions imported.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_ids: {
          type: 'array' as const,
          items: { type: 'string' as const },
          description: 'Optional list of account ids to sync. Omit to sync all connected accounts.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'csv_import',
    description:
      'Import transactions from a pasted CSV. Requires csv (string) and account_id (string).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        csv: { type: 'string' as const, description: 'CSV content as a single string.' },
        account_id: { type: 'string' as const, description: 'Target account id.' },
      },
      required: ['csv', 'account_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'amazon_import',
    description:
      'Import Amazon order context for matching against existing transactions. Requires csv (string) containing the Amazon order history export.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        csv: { type: 'string' as const, description: 'Amazon order history CSV content.' },
      },
      required: ['csv'],
      additionalProperties: false,
    },
  },
  {
    name: 'tiller_import',
    description:
      'Import historical transactions from a Tiller spreadsheet export. Requires csv (string).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        csv: { type: 'string' as const, description: 'Tiller transactions CSV.' },
      },
      required: ['csv'],
      additionalProperties: false,
    },
  },
  {
    name: 'classify_transactions',
    description:
      'Run AI classification against the currently-unclassified transactions. Returns a summary of how many were auto-accepted vs. flagged for review.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number' as const,
          description: 'Max number of transactions to classify in this run (default 50).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_account_owner',
    description:
      "Assign a business entity to a bank/credit-card account (sets owner_tag). All transactions from that account will be tagged to the entity by default. Pass entity=null to clear the assignment. After calling this, call reapply_account_rules to retroactively tag historical transactions.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_id: {
          type: 'string' as const,
          description: 'The account id to update (from list_accounts or transactions).',
        },
        entity: {
          type: ['string', 'null'] as ['string', 'null'],
          enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal', null],
          description: 'Business entity to assign, or null to clear.',
        },
      },
      required: ['account_id', 'entity'],
      additionalProperties: false,
    },
  },
  {
    name: 'reapply_account_rules',
    description:
      'Re-run the rules engine against all existing transactions from accounts that have a business assigned (owner_tag). Overwrites any prior AI classification that is not locked or manually set. Use this after assigning a business to an account for the first time to retroactively tag historical transactions.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_review_queue',
    description:
      'List transactions in the review queue — the ones AI flagged as low-confidence or ambiguous. Use this when the user asks "what needs my attention".',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'next_review_item',
    description:
      "Interview mode: pulls the next single pending review item and returns it with full context — transaction details, the current AI suggestion, the user's historical classifications for the same merchant, any active rules that match, and similar merchants. Use this when the user says 'walk me through categorization' or 'let's categorize some transactions'. Present ONE item at a time, show the user the precedent, recommend a classification, and wait for their decision. Then call resolve_review with action='classify' (or 'accept' to keep the AI suggestion, 'skip' to defer). Loop until queue_remaining is 0 or the user stops. Every classify decision feeds the learning loop — after 3+ consistent manual decisions for the same merchant, a rule is auto-created so future transactions get categorized without a prompt.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_review',
    description:
      "Resolve a single review queue item. Pass action='classify' with entity + category_tax (and optional category_budget) to set a fresh classification — this also feeds the learning loop. Use action='accept' to keep the existing AI suggestion, 'skip' to defer, 'reopen' to unresolve.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        review_id: { type: 'string' as const },
        action: {
          type: 'string' as const,
          enum: ['accept', 'classify', 'skip', 'reopen'],
          description: 'What to do with this review item.',
        },
        entity: {
          type: 'string' as const,
          enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
          description: "Required for action='classify'.",
        },
        category_tax: { type: 'string' as const, description: "Required for action='classify'." },
        category_budget: { type: 'string' as const, description: "Optional budget category." },
        expense_type: {
          type: 'string' as const,
          enum: ['recurring', 'one_time'],
          description: "Optional. Mark this transaction 'one_time' to exclude it from anticipated-expense forecasts (e.g. an unusual one-off purchase inside a normally-recurring category). Defaults to recurring.",
        },
        cut_status: {
          type: 'string' as const,
          enum: ['flagged', 'complete'],
          description: "Optional. Mark this transaction 'flagged' to earmark the expense for elimination, or 'complete' once it's actually been cancelled. Omit (or pass null via commit_bookkeeping_decisions) to leave unflagged.",
        },
      },
      required: ['review_id', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'schedule_c_report',
    description:
      "Generate a Schedule C report for one of the two coaching businesses. Use entity='elyse_coaching' for Elyse's or 'jeremy_coaching' for Jeremy's. Returns per-category totals keyed to IRS form line numbers.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity: {
          type: 'string' as const,
          enum: ['elyse_coaching', 'jeremy_coaching'],
          description: "Which coaching business Schedule C to generate. Defaults to elyse_coaching.",
        },
        tax_year: { type: 'number' as const, description: 'Optional — defaults to the active workflow year.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'schedule_e_report',
    description:
      'Generate the Schedule E (rental property) report for the current tax year.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tax_year: { type: 'number' as const, description: 'Optional — defaults to the active workflow year.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'transactions_summary',
    description:
      'Top-level summary of classified totals by entity + category for the current tax year. Use when the user asks "how much did I spend on X".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tax_year: { type: 'number' as const },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_budget_categories',
    description:
      "List the user's budget categories. On first use this seeds a default set (groceries, dining_out, subscriptions, etc.) from FAMILY_CATEGORIES so the budget walkthrough always has something to iterate over. Returns each category with its slug and display name. For the walkthrough flow, call this first, then for each category call set_budget_target (or create_budget_category for anything new the user invents) and finally budget_status to confirm.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'create_budget_category',
    description:
      "Create a new budget category mid-interview when the user names a bucket the defaults don't cover (e.g. 'kids_activities', 'coffee'). slug is lowercase_with_underscores and must be unique per user; name is the human label.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string' as const, description: 'lowercase_with_underscores identifier' },
        name: { type: 'string' as const, description: 'Human display name' },
        parent_slug: { type: 'string' as const, description: 'Optional parent category for hierarchy' },
      },
      required: ['slug', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_budget_target',
    description:
      "Set or update the target amount for a budget category. Cadence is 'weekly', 'monthly', 'annual', or 'one_time' — pick whichever the user thinks about naturally (dining out is easier monthly, gifts are easier annual, kitchen remodel or named vacation is one_time). One-time targets are fixed envelopes and are excluded from the anticipated-monthly forecast. Upserting creates history; the prior open-ended target is closed automatically so trendlines still work.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        category_slug: { type: 'string' as const },
        cadence: { type: 'string' as const, enum: ['weekly', 'monthly', 'annual', 'one_time'] },
        amount: { type: 'number' as const, description: 'Target amount in dollars, non-negative' },
        notes: { type: 'string' as const, description: 'Optional free-text context' },
      },
      required: ['category_slug', 'cadence', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'budget_forecast',
    description:
      "Anticipated recurring expenses, expressed monthly and annually. Hybrid logic per category: if there's an active target use it, otherwise use the trailing-12-month average of actual spend. One-time targets are listed separately, and transactions tagged expense_type='one_time' are excluded from the historical fallback. Use when the user asks 'what should I expect to spend each month' or 'what are my recurring expenses'.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'cuts_report',
    description:
      "Report on transactions flagged for elimination. Returns two buckets — 'flagged' (still want to cut) and 'complete' (already cancelled) — each with category and merchant breakdowns, plus an estimated_annual_savings figure. Annualized savings is computed by deduping completed cuts on merchant_name and summing each merchant's trailing-12-month spend, so cancelling a $15/mo subscription shows up as ~$180/yr saved. Use when the user asks 'what am I trying to cut', 'how much have I saved', or 'show me my cancelled subscriptions'.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'pnl_for_entity',
    description:
      "Income statement (P&L) for a single entity over a period. Entities are 'elyse_coaching' (Elyse's Schedule C), 'jeremy_coaching' (Jeremy's Schedule C), 'airbnb_activity' (Schedule E), or 'family_personal'. Returns income and expenses grouped by tax category, plus net income and a count of still-unreviewed transactions in the window. Use when the user asks 'how's the business doing', 'what did I spend on the airbnb last month', or 'am I profitable this quarter'. Period defaults to this_month; accepts the same presets as budget_status.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity: {
          type: 'string' as const,
          enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
        },
        preset: {
          type: 'string' as const,
          enum: ['this_week', 'this_month', 'last_month', 'ytd', 'trailing_30d', 'trailing_90d'],
        },
        start: { type: 'string' as const, description: 'YYYY-MM-DD, overrides preset' },
        end: { type: 'string' as const, description: 'YYYY-MM-DD, overrides preset' },
      },
      required: ['entity'],
      additionalProperties: false,
    },
  },
  {
    name: 'pnl_all_entities',
    description:
      "Consolidated income statement covering all four entities (elyse_coaching, jeremy_coaching, airbnb_activity, family_personal) at once, plus a rollup total. Use for 'how did the household do this month' or 'give me a snapshot of everything'. Period defaults to this_month.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        preset: {
          type: 'string' as const,
          enum: ['this_week', 'this_month', 'last_month', 'ytd', 'trailing_30d', 'trailing_90d'],
        },
        start: { type: 'string' as const, description: 'YYYY-MM-DD, overrides preset' },
        end: { type: 'string' as const, description: 'YYYY-MM-DD, overrides preset' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pnl_monthly_trend',
    description:
      "Month-by-month income, expenses, and net income for an entity across the last N months (default 6, max 36). Use for run-rate questions: 'how has the coaching business trended', 'what's my monthly burn', 'are expenses creeping up'. Also returns monthly averages across the window.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        entity: {
          type: 'string' as const,
          enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
        },
        months: {
          type: 'number' as const,
          description: 'Number of months to include (1-36, default 6)',
        },
      },
      required: ['entity'],
      additionalProperties: false,
    },
  },
  {
    name: 'budget_status',
    description:
      "Spend-vs-target report for a period. Target amounts are pro-rated across cadence mismatches so a weekly query against a $600/mo grocery target yields ~$138 expected, not $600. Use when the user asks 'how am I doing on X this month' or 'am I over budget'. Period defaults to this_month; accepts preset (this_week|this_month|last_month|ytd|trailing_30d|trailing_90d) or explicit start+end. Pass category_slug to drill into one bucket.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        preset: {
          type: 'string' as const,
          enum: ['this_week', 'this_month', 'last_month', 'ytd', 'trailing_30d', 'trailing_90d'],
        },
        start: { type: 'string' as const, description: 'YYYY-MM-DD, overrides preset' },
        end: { type: 'string' as const, description: 'YYYY-MM-DD, overrides preset' },
        category_slug: { type: 'string' as const, description: 'Filter to a single category' },
      },
      additionalProperties: false,
    },
  },

  // ── Bookkeeping session tools ───────────────────────────────────────────────
  {
    name: 'start_bookkeeping_session',
    description:
      "Start a bookkeeping session for one of the four businesses: elyse_coaching (Elyse's Coaching), jeremy_coaching (Jeremy's Coaching), airbnb_activity (Whitford House Airbnb), or family_personal (Family / Personal). Returns a summary of how many transactions need attention in each phase (income_confident, income_uncertain, expense_confident, expense_uncertain), the stored bookkeeping notes from prior sessions, and which phase to start with. Not tied to any tax year — works across all dates. Call this first, then use get_bookkeeping_batch to pull batches of 20, review them with the user, and commit_bookkeeping_decisions to save. The session flow is: (1) income the AI is fairly confident about → confirm or fix, (2) income the AI is less sure about → classify, (3) expenses the AI is confident about → confirm or fix, (4) uncertain expenses → classify. Along the way, save notes about patterns you learn via save_bookkeeping_notes so future sessions get smarter.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        business: {
          type: 'string' as const,
          enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
          description: "Which business to run bookkeeping for.",
        },
      },
      required: ['business'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_bookkeeping_batch',
    description:
      "Fetch the next batch of up to 20 transactions for a bookkeeping session phase. Each transaction includes a line number, the AI's current suggestion (entity + category + confidence), account info, and merchant details. Present these to the user as a numbered list. The user can accept the suggestion, reclassify, or skip. Use offset to paginate through large phases.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        business: {
          type: 'string' as const,
          enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
        },
        phase: {
          type: 'string' as const,
          enum: ['income_confident', 'income_uncertain', 'expense_confident', 'expense_uncertain'],
          description: 'Which phase to pull transactions from.',
        },
        offset: {
          type: 'number' as const,
          description: 'Skip this many transactions (for pagination). Default 0.',
        },
      },
      required: ['business', 'phase'],
      additionalProperties: false,
    },
  },
  {
    name: 'commit_bookkeeping_decisions',
    description:
      "Commit a batch of bookkeeping decisions. Each decision is { transaction_id, action, entity?, category_tax?, category_budget?, expense_type?, cut_status? }. Actions: 'classify' (set entity + category_tax, feeds the learning loop), 'accept' (keep existing AI suggestion), 'skip' (defer to later). Pass expense_type='one_time' on a classify decision to exclude it from forecasts; pass cut_status='flagged' to earmark it for elimination or 'complete' once cancelled. Returns counts of classified/accepted/skipped/errors. Every classify decision trains the auto-categorization rules — after 3+ consistent manual decisions for the same merchant, a rule is auto-created.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        decisions: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              transaction_id: { type: 'string' as const },
              action: { type: 'string' as const, enum: ['classify', 'accept', 'skip'] },
              entity: {
                type: 'string' as const,
                enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
              },
              category_tax: { type: 'string' as const },
              category_budget: { type: 'string' as const },
              expense_type: { type: 'string' as const, enum: ['recurring', 'one_time'] },
              cut_status: { type: 'string' as const, enum: ['flagged', 'complete'] },
            },
            required: ['transaction_id', 'action'],
          },
          description: 'Array of decisions, max 100 per call.',
        },
      },
      required: ['decisions'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_bookkeeping_notes',
    description:
      "Read the bookkeeping notes file for a business. These notes are written by the assistant during prior bookkeeping sessions and contain learned patterns, merchant categorization decisions, and session history. Read these at the start of every bookkeeping session to make better categorization decisions.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        business: {
          type: 'string' as const,
          enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
        },
      },
      required: ['business'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_bookkeeping_notes',
    description:
      "Write the bookkeeping notes file for a business. Replaces the entire file. Use this during or after a bookkeeping session to record: (1) merchant categorization patterns learned (e.g. 'Kajabi charges are elyse_coaching / office_expense'), (2) edge cases or ambiguous merchants to watch for, (3) session summaries. Keep notes concise and structured so they're useful for future sessions.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        business: {
          type: 'string' as const,
          enum: ['elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal'],
        },
        notes: {
          type: 'string' as const,
          description: 'The full markdown content to save as the notes file.',
        },
      },
      required: ['business', 'notes'],
      additionalProperties: false,
    },
  },
];

// ── Dispatch ──────────────────────────────────────────────────────────────────

export async function handleMcp(
  message: JsonRpcMessage,
  env: Env,
): Promise<unknown> {
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
          "CFO agent: bookkeeping, budgeting, cash-flow, retirement and tax prep. Four entities: Elyse's Coaching (Schedule C), Jeremy's Coaching (Schedule C), Whitford House (Schedule E), Family/Personal. Bank ingest via Teller, classification via Claude.",
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
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }] },
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return { jsonrpc: '2.0', id, error: { code: -32000, message: errorMessage } };
    }
  }

  if (method === 'notifications/initialized') return null;

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
): Promise<string> {
  switch (name) {
    case 'teller_sync': {
      const req = jsonRequest('POST', 'https://cfo.invalid/bank/sync', {
        provider: 'teller',
        account_ids: args.account_ids,
      });
      return respondText(await handleBankSync(req, env));
    }

    case 'csv_import': {
      const req = jsonRequest('POST', 'https://cfo.invalid/imports/csv', args);
      return respondText(await handleCsvImport(req, env));
    }

    case 'amazon_import': {
      const req = jsonRequest('POST', 'https://cfo.invalid/imports/amazon', args);
      return respondText(await handleAmazonImport(req, env));
    }

    case 'tiller_import': {
      const req = jsonRequest('POST', 'https://cfo.invalid/imports/tiller', args);
      return respondText(await handleTillerImport(req, env));
    }

    case 'classify_transactions': {
      const req = jsonRequest('POST', 'https://cfo.invalid/classify/run', args);
      return respondText(await handleRunClassification(req, env));
    }

    case 'set_account_owner': {
      const accountId = String(args.account_id ?? '');
      if (!accountId) throw new Error('account_id is required');
      const req = jsonRequest('PATCH', `https://cfo.invalid/accounts/${accountId}`, { owner_tag: args.entity ?? null });
      return respondText(await handleUpdateAccount(req, env, accountId));
    }

    case 'reapply_account_rules': {
      const req = jsonRequest('POST', 'https://cfo.invalid/classify/reapply-account-rules', {});
      return respondText(await handleReapplyAccountRules(req, env));
    }

    case 'list_review_queue': {
      const req = jsonRequest('GET', 'https://cfo.invalid/review');
      return respondText(await handleListReview(req, env));
    }

    case 'next_review_item': {
      const req = jsonRequest('GET', 'https://cfo.invalid/review/next');
      return respondText(await handleNextReviewItem(req, env));
    }

    case 'resolve_review': {
      const reviewId = String(args.review_id ?? '');
      if (!reviewId) throw new Error('review_id is required');
      const req = jsonRequest('PATCH', `https://cfo.invalid/review/${reviewId}`, args);
      return respondText(await handleResolveReview(req, env, reviewId));
    }

    case 'schedule_c_report': {
      const schedCArgs = { ...args };
      if (schedCArgs.tax_year) schedCArgs.year = schedCArgs.tax_year;
      delete schedCArgs.tax_year;
      const url = withQuery('https://cfo.invalid/reports/schedule-c', schedCArgs);
      const req = jsonRequest('GET', url);
      return respondText(await handleScheduleC(req, env));
    }

    case 'schedule_e_report': {
      const url = withQuery('https://cfo.invalid/reports/schedule-e', args);
      const req = jsonRequest('GET', url);
      return respondText(await handleScheduleE(req, env));
    }

    case 'transactions_summary': {
      const url = withQuery('https://cfo.invalid/reports/summary', args);
      const req = jsonRequest('GET', url);
      return respondText(await handleSummary(req, env));
    }

    case 'list_budget_categories': {
      const req = jsonRequest('GET', 'https://cfo.invalid/budget/categories');
      return respondText(await handleListBudgetCategories(req, env));
    }

    case 'create_budget_category': {
      const req = jsonRequest('POST', 'https://cfo.invalid/budget/categories', args);
      return respondText(await handleCreateBudgetCategory(req, env));
    }

    case 'set_budget_target': {
      const req = jsonRequest('PUT', 'https://cfo.invalid/budget/targets', args);
      return respondText(await handleUpsertBudgetTarget(req, env));
    }

    case 'budget_status': {
      const url = withQuery('https://cfo.invalid/budget/status', args);
      const req = jsonRequest('GET', url);
      return respondText(await handleBudgetStatus(req, env));
    }

    case 'budget_forecast': {
      const req = jsonRequest('GET', 'https://cfo.invalid/budget/forecast');
      return respondText(await handleBudgetForecast(req, env));
    }

    case 'cuts_report': {
      const req = jsonRequest('GET', 'https://cfo.invalid/budget/cuts');
      return respondText(await handleBudgetCutsReport(req, env));
    }

    case 'pnl_for_entity': {
      const url = withQuery('https://cfo.invalid/pnl', args);
      const req = jsonRequest('GET', url);
      return respondText(await handlePnL(req, env));
    }

    case 'pnl_all_entities': {
      const url = withQuery('https://cfo.invalid/pnl/all', args);
      const req = jsonRequest('GET', url);
      return respondText(await handlePnLAll(req, env));
    }

    case 'pnl_monthly_trend': {
      const url = withQuery('https://cfo.invalid/pnl/trend', args);
      const req = jsonRequest('GET', url);
      return respondText(await handlePnLTrend(req, env));
    }

    case 'start_bookkeeping_session': {
      const url = withQuery('https://cfo.invalid/bookkeeping/session', { entity: args.business });
      const req = jsonRequest('GET', url);
      return respondText(await handleBookkeepingSession(req, env));
    }

    case 'get_bookkeeping_batch': {
      const url = withQuery('https://cfo.invalid/bookkeeping/batch', {
        entity: args.business,
        phase: args.phase,
        offset: args.offset,
      });
      const req = jsonRequest('GET', url);
      return respondText(await handleBookkeepingBatch(req, env));
    }

    case 'commit_bookkeeping_decisions': {
      const req = jsonRequest('POST', 'https://cfo.invalid/bookkeeping/commit', args);
      return respondText(await handleBookkeepingCommit(req, env));
    }

    case 'get_bookkeeping_notes': {
      const url = withQuery('https://cfo.invalid/bookkeeping/notes', { entity: args.business });
      const req = jsonRequest('GET', url);
      return respondText(await handleGetBookkeepingNotes(req, env));
    }

    case 'save_bookkeeping_notes': {
      const req = jsonRequest('PUT', 'https://cfo.invalid/bookkeeping/notes', {
        entity: args.business,
        notes: args.notes,
      });
      return respondText(await handleSaveBookkeepingNotes(req, env));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonRequest(method: string, url: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      // Default user id for MCP-originated requests. If we later expose
      // multi-user CFO, thread this through the MCP session.
      'x-user-id': 'default',
    },
  };
  if (body !== undefined && method !== 'GET') {
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

function withQuery(base: string, args: Record<string, unknown>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function respondText(res: Response): Promise<string> {
  // Keep payloads small enough for Claude's tool_result context. If a
  // report ever gets huge we'll truncate or link to an R2 object here.
  const text = await res.text();
  return text;
}
