/**
 * Tool registry for the in-app chat.
 *
 * All 10 MCP tools are below the AGENTS.md ≤10 limit so the entire MCP
 * surface is allowlisted as-is. If new tools are added, prune here.
 */

import type { Env } from './types';
import { dispatchTool, MCP_TOOLS } from './mcp-tools';
import { truncateForChat, drillInFor } from './lib/tool-result-truncate';

/**
 * Curated chat allowlist (AGENTS.md rule 2: ≤10 tools). The two ops tools
 * (accounts_list, sync_run) are dropped from chat — they're still reachable
 * via direct MCP, but they don't help the model answer questions and slow
 * tool selection.
 */
export const TOOL_ALLOWLIST: string[] = [
  'review_status',
  'review_next',
  'review_resolve',
  'review_bulk_accept',
  'spending_summary',
  'plan_forecast',
  'transactions_list',
  'rules_create',
  'report_generate',
  'report_list_configs',
];

interface KitTool {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

function envelope(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

export function buildWebChatTools(env: Env): Record<string, KitTool> {
  const byName = new Map(MCP_TOOLS.map(t => [t.name, t] as const));
  const reg: Record<string, KitTool> = {};
  for (const name of TOOL_ALLOWLIST) {
    const def = byName.get(name as (typeof MCP_TOOLS)[number]['name']);
    if (!def) throw new Error(`web-chat-tools: TOOL_ALLOWLIST references unknown tool "${name}"`);
    reg[name] = {
      description: def.description,
      inputSchema: def.inputSchema as Record<string, unknown>,
      run: async (args) => {
        try {
          const raw = await dispatchTool(name, args ?? {}, env);
          const capped = truncateForChat(raw, { drillInHint: drillInFor(name) });
          return envelope(capped);
        } catch (err) {
          return envelope(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    };
  }
  return reg;
}
