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
import { handleBankSync } from './routes/bank';
import { handleCsvImport } from './routes/imports';
import { handleAmazonImport } from './routes/amazon';
import { handleTillerImport } from './routes/tiller';
import { handleRunClassification } from './routes/classify';
import { handleListReview, handleResolveReview, handleNextReviewItem } from './routes/review';
import { handleScheduleC, handleScheduleE, handleSummary } from './routes/reports';

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
          enum: ['coaching_business', 'airbnb_activity', 'family_personal'],
          description: "Required for action='classify'.",
        },
        category_tax: { type: 'string' as const, description: "Required for action='classify'." },
        category_budget: { type: 'string' as const, description: "Optional budget category." },
      },
      required: ['review_id', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'schedule_c_report',
    description:
      'Generate the Schedule C (sole-proprietor coaching business) report for the current tax year. Returns per-category totals keyed to IRS form line numbers.',
    inputSchema: {
      type: 'object' as const,
      properties: {
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
          'CFO agent: bookkeeping, budgeting, cash-flow, retirement and tax prep. Bank ingest via Teller, classification via Claude, reports for Schedule C and Schedule E.',
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

async function dispatchTool(
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
      const url = withQuery('https://cfo.invalid/reports/schedule-c', args);
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
