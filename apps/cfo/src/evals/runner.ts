/**
 * Test runner that drives the chat tool-loop with a stubbed tool
 * registry, so evals can assert tool selection without hitting the
 * real DB or burning Anthropic budget on data fetches.
 *
 * The MODEL is real — that's the whole point of AI-1. Tool RESPONSES
 * are canned per tool name from FIXTURES. To test "does the model
 * pick the right tool for this question", we don't need realistic
 * data; we just need responses that look plausible enough that the
 * model continues normally.
 */

import { runChat } from "@agentbuilder/web-ui-kit";
import { MCP_TOOLS } from "../mcp-tools";
import { TOOL_ALLOWLIST } from "../web-chat-tools";
import { SYSTEM_PROMPT } from "../web-chat";

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

export interface EvalResult {
  reply: string;
  iterations: number;
  toolCalls: ToolCallRecord[];
  stopReason: string | undefined;
}

// Canned tool responses keyed by name. Realistic enough to keep the
// model from spiraling into "let me try a different tool" loops.
export const FIXTURES: Record<string, unknown> = {
  list_review_queue: {
    items: [
      { id: "rq_1", merchant_name: "Lyft",   amount: -23.50, posted_date: "2026-04-12", suggested_category_tax: "travel",       suggested_confidence: 0.62 },
      { id: "rq_2", merchant_name: "Costco", amount: -187.40, posted_date: "2026-04-13", suggested_category_tax: "supplies",     suggested_confidence: 0.71 },
      { id: "rq_3", merchant_name: "USPS",   amount: -8.95,  posted_date: "2026-04-14", suggested_category_tax: "office_expense", suggested_confidence: 0.55 },
    ],
    total: 12,
    limit: 50,
    offset: 0,
  },
  next_review_item: {
    id: "rq_1",
    transaction_id: "tx_1",
    merchant_name: "Lyft",
    amount: -23.50,
    posted_date: "2026-04-12",
    suggested_entity: "elyse_coaching",
    suggested_category_tax: "travel",
    suggested_confidence: 0.62,
    historical_examples: [],
    matching_rules: [],
  },
  resolve_review: { ok: true },
  transactions_summary: {
    tax_year: "2025",
    by_entity: [
      { entity: "elyse_coaching", total: 48230, count: 142 },
      { entity: "family_personal", total: -23410, count: 281 },
    ],
    by_month: [],
    review_queue: [{ status: "pending", count: 12 }],
  },
  pnl_all_entities: {
    period: { start: "2026-04-01", end: "2026-04-26", days: 26, label: "April 2026" },
    entities: [
      { entity: "elyse_coaching",  income: { total: 5400 }, expenses: { total: 1820 }, net_income: 3580 },
      { entity: "jeremy_coaching", income: { total: 2200 }, expenses: { total: 540 },  net_income: 1660 },
      { entity: "airbnb_activity", income: { total: 4200 }, expenses: { total: 1100 }, net_income: 3100 },
      { entity: "family_personal", income: { total: 0 },    expenses: { total: 6240 }, net_income: -6240 },
    ],
    consolidated: { income: 11800, expenses: 9700, net_income: 2100 },
  },
  budget_status: {
    period: { start: "2026-04-01", end: "2026-04-26", days: 26, label: "April 2026" },
    categories: [
      { category_slug: "groceries", category_name: "Groceries", spent: 1240, target: { prorated_amount: 1300 }, percent_used: 95.4, status: "near" },
      { category_slug: "travel",    category_name: "Travel",    spent: 380,  target: { prorated_amount: 250 },  percent_used: 152.0, status: "over" },
      { category_slug: "dining_out",category_name: "Dining out",spent: 210,  target: { prorated_amount: 400 },  percent_used: 52.5,  status: "under" },
    ],
  },
  schedule_c_report: {
    tax_year: "2025",
    entity: "elyse_coaching",
    schedule: "C",
    income: {
      categories: [{ category_tax: "income", category_name: "Gross receipts", form_line: "Line 1", total_amount: 48230, transaction_count: 142 }],
      total: 48230,
    },
    expenses: {
      categories: [
        { category_tax: "advertising",      category_name: "Advertising",      form_line: "Line 8",  total_amount: 1240, transaction_count: 18 },
        { category_tax: "office_expense",   category_name: "Office expense",   form_line: "Line 18", total_amount: 980,  transaction_count: 22 },
      ],
      total: 2220,
    },
    net_profit: 46010,
    pending_review: 3,
  },
  classify_transactions: { total: 12, rules: 4, ai: 6, review_required: 2 },
  start_bookkeeping_session: {
    entity: "elyse_coaching",
    phases: ["unclassified", "low_confidence", "review"],
    counts: { unclassified: 8, low_confidence: 3, review: 0 },
  },
  get_bookkeeping_batch: {
    entity: "elyse_coaching",
    phase: "unclassified",
    items: [],
    next_offset: null,
  },
};

interface KitTool {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/** Build a tool registry that records calls + returns canned data. */
function buildStubbedTools(record: ToolCallRecord[]): Record<string, KitTool> {
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t] as const));
  const reg: Record<string, KitTool> = {};
  for (const name of TOOL_ALLOWLIST) {
    const def = byName.get(name);
    if (!def) throw new Error(`unknown tool ${name} in TOOL_ALLOWLIST`);
    reg[name] = {
      description: def.description,
      inputSchema: def.inputSchema as Record<string, unknown>,
      run: async (args) => {
        record.push({ name, args: args ?? {} });
        const fixture = FIXTURES[name] ?? { ok: true };
        return { content: [{ type: "text" as const, text: JSON.stringify(fixture) }] };
      },
    };
  }
  return reg;
}

export interface RunCaseOptions {
  apiKey: string;
  message: string;
  tier?: "fast" | "default" | "deep";
  maxIterations?: number;
}

/**
 * Run one golden case end-to-end. Returns the reply, iteration count,
 * and the recorded tool calls so the test layer can assert against
 * the case's expectations.
 */
export async function runEvalCase(opts: RunCaseOptions): Promise<EvalResult> {
  const toolCalls: ToolCallRecord[] = [];
  const tools = buildStubbedTools(toolCalls);
  const result = await runChat({
    ctx: { tools, env: { ANTHROPIC_API_KEY: opts.apiKey } as Record<string, unknown> },
    body: { message: opts.message, history: [] },
    toolAllowlist: [...TOOL_ALLOWLIST],
    system: SYSTEM_PROMPT,
    tier: opts.tier ?? "fast",
    maxIterations: opts.maxIterations ?? 6,
  });
  return {
    reply: result.reply,
    iterations: result.iterations,
    toolCalls,
    stopReason: result.stopReason as string | undefined,
  };
}

// ── Assertion helpers ─────────────────────────────────────────────────────

export function assertCalled(toolCalls: ToolCallRecord[], expected: string[]): string | null {
  const names = new Set(toolCalls.map((c) => c.name));
  for (const exp of expected) {
    if (!names.has(exp)) return `expected tool "${exp}" to be called; got [${[...names].join(", ")}]`;
  }
  return null;
}

export function assertNotCalled(toolCalls: ToolCallRecord[], forbidden: string[]): string | null {
  const names = new Set(toolCalls.map((c) => c.name));
  for (const forb of forbidden) {
    if (names.has(forb)) return `tool "${forb}" was called but shouldn't have been`;
  }
  return null;
}

export function assertCalledAnyOf(toolCalls: ToolCallRecord[], options: string[]): string | null {
  const names = new Set(toolCalls.map((c) => c.name));
  if (options.some((o) => names.has(o))) return null;
  return `expected at least one of [${options.join(", ")}] to be called; got [${[...names].join(", ")}]`;
}

export function assertReplyMentions(reply: string, mentions: string[]): string | null {
  const lower = reply.toLowerCase();
  for (const m of mentions) {
    if (!lower.includes(m.toLowerCase())) {
      return `reply missing token "${m}". Reply was: ${reply.slice(0, 200)}`;
    }
  }
  return null;
}

export function assertReplyForbids(reply: string, forbidden: string[]): string | null {
  const lower = reply.toLowerCase();
  for (const f of forbidden) {
    if (lower.includes(f.toLowerCase())) {
      return `reply contains forbidden token "${f}"`;
    }
  }
  return null;
}
