/**
 * Tool registry for the in-app chat.
 *
 * All 10 MCP tools are below the AGENTS.md ≤10 limit so the entire MCP
 * surface is allowlisted as-is. If new tools are added, prune here.
 */

import type { Env } from './types';
import { dispatchTool, MCP_TOOLS } from './mcp-tools';
import { truncateForChat, drillInFor } from './lib/tool-result-truncate';

export const TOOL_ALLOWLIST = MCP_TOOLS.map(t => t.name);

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
    const def = byName.get(name);
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
