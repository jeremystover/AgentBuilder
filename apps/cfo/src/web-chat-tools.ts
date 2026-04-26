/**
 * Curated tool registry for the web chat.
 *
 * The CFO worker exposes a 23-tool MCP surface (see mcp-tools.ts). That
 * full surface is fine for Claude.ai's external custom-tool integration
 * — it's a power-user surface — but for the in-app chat we want fewer
 * choices to keep latency low and the model focused (AGENTS.md rule 2:
 * ≤10 tools per chat surface).
 *
 * The cut below is read-heavy daily-driver tools plus a small set of
 * mutations (resolve_review, classify_transactions). The chat will not
 * trigger Teller syncs, ingest CSVs, edit rules, or commit bookkeeping
 * decisions — those have UI confirmation flows of their own and should
 * stay there.
 *
 * Implementation note: rather than re-implement each tool's wiring, we
 * reuse mcp-tools.ts's `dispatchTool` directly. That keeps MCP and web
 * chat bug-for-bug identical and means new MCP tools can be promoted
 * to the chat by adding their name to TOOL_ALLOWLIST.
 */

import type { Env } from './types';
import { dispatchTool, MCP_TOOLS } from './mcp-tools';

// Curated subset, ordered by likelihood the model will reach for each.
export const TOOL_ALLOWLIST = [
  'list_review_queue',
  'next_review_item',
  'resolve_review',
  'transactions_summary',
  'pnl_all_entities',
  'budget_status',
  'schedule_c_report',
  'classify_transactions',
  'start_bookkeeping_session',
  'get_bookkeeping_batch',
] as const;

interface KitTool {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

function envelope(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

export function buildWebChatTools(env: Env): Record<string, KitTool> {
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t] as const));
  const reg: Record<string, KitTool> = {};
  for (const name of TOOL_ALLOWLIST) {
    const def = byName.get(name);
    if (!def) {
      // Should never happen — fail loudly so we catch it in CI.
      throw new Error(`web-chat-tools: TOOL_ALLOWLIST references unknown tool "${name}"`);
    }
    reg[name] = {
      description: def.description,
      inputSchema: def.inputSchema as Record<string, unknown>,
      run: async (args) => {
        try {
          const text = await dispatchTool(name, args ?? {}, env);
          return envelope(text);
        } catch (err) {
          return envelope(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    };
  }
  return reg;
}
