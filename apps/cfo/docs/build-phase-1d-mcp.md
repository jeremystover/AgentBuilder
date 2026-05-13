# Build Prompt — Phase 1d: MCP Agent Layer

**Session goal:** Build the MCP server and define the tool set for the cfo agent. This exposes the system to Claude via the AgentBuilder fleet.

**Before writing any code:** Read `apps/cfo/CLAUDE.md`. Read `apps/cfo/src/mcp-tools.ts` in full — you are reusing the `dispatchTool` pattern and the "thin wrapper over REST" architecture. Also read `AGENTS.md` at the repo root for fleet rules.

**Phase 1c must be complete (REST routes must exist) before starting this session.**

---

## Step 1: Review the AGENTS.md rules

Before defining tools, read `AGENTS.md`. Key rules that apply here:

- Maximum 10 tools exposed to Claude at any one time (the in-app chat allowlist rule)
- Tool descriptions must be precise — they are what Claude reads to decide which tool to call
- Model tiers, not model IDs
- Each tool must have a clear, single responsibility

The CFO violates the 10-tool rule with 24+ exposed tools. This system starts clean. The MCP server can define more tools, but the in-app chat allowlist must stay at ≤10.

---

## Step 2: Define the tool set

Create `src/mcp-tools.ts` following the CFO's exact architecture:
- `MCP_TOOLS` array with `name`, `description`, `inputSchema` per tool
- `dispatchTool(name, args, env)` switch that builds synthetic Requests and calls REST handlers
- `jsonRequest`, `withQuery`, `respondText` helpers (copy from CFO)
- `handleMcp(request, env)` entry point

**Full tool list:**

```typescript
// --- REVIEW TOOLS ---

{
  name: "review_next",
  description: "Get the next transaction pending human review, with AI reasoning, matched rules, and similar past transactions for context. Returns one transaction at a time for interview-mode review. Use repeatedly to work through the queue.",
  inputSchema: {
    type: "object",
    properties: {
      entity: { type: "string", description: "Filter to a specific entity slug" },
      min_confidence: { type: "number", description: "Only return transactions with AI confidence below this threshold (e.g. 0.7 to focus on uncertain ones)" }
    }
  }
}

{
  name: "review_resolve",
  description: "Accept or reclassify a pending transaction. Use 'accept' to approve the AI's suggestion, or provide entity_slug and category_slug to reclassify before approving.",
  inputSchema: {
    type: "object",
    required: ["transaction_id", "action"],
    properties: {
      transaction_id: { type: "string" },
      action: { type: "string", enum: ["accept", "reclassify", "skip", "mark_transfer", "mark_reimbursable"] },
      entity_slug: { type: "string" },
      category_slug: { type: "string" },
      note: { type: "string", description: "Optional note explaining the decision" }
    }
  }
}

{
  name: "review_bulk_accept",
  description: "Approve all pending transactions matching a filter in one operation. Use for high-confidence batches (e.g. all rule-matched transactions, or all transactions from a specific merchant).",
  inputSchema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["rule", "ai"], description: "Accept only rule-matched or AI-classified transactions" },
      min_confidence: { type: "number", description: "Accept only transactions at or above this confidence (e.g. 0.9)" },
      entity_slug: { type: "string" },
      date_from: { type: "string" },
      date_to: { type: "string" }
    }
  }
}

// --- TRANSACTION TOOLS ---

{
  name: "transactions_list",
  description: "Search and filter approved transactions. Use to answer questions like 'show me all Costco charges this year' or 'what did we spend on dining in Q1'.",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string", description: "Search term for description or merchant" },
      entity_slug: { type: "string" },
      category_slug: { type: "string" },
      date_from: { type: "string" },
      date_to: { type: "string" },
      limit: { type: "number", default: 25 },
      offset: { type: "number", default: 0 }
    }
  }
}

{
  name: "transactions_summary",
  description: "Summarize approved transactions by entity and category for a time period. Returns totals per category with transaction counts. Good for 'how much did we spend on X this month' questions.",
  inputSchema: {
    type: "object",
    properties: {
      period: { type: "string", enum: ["this_month", "last_month", "this_quarter", "last_quarter", "ytd", "trailing_30d", "trailing_90d", "custom"] },
      date_from: { type: "string" },
      date_to: { type: "string" },
      entity_slug: { type: "string" }
    }
  }
}

// --- RULES TOOLS ---

{
  name: "rules_list",
  description: "List active classification rules. Shows what patterns are being auto-classified and how many transactions each rule has matched.",
  inputSchema: {
    type: "object",
    properties: {
      entity_slug: { type: "string" }
    }
  }
}

{
  name: "rules_create",
  description: "Create a new classification rule. The rule will be applied to all future transactions matching the criteria. Use after the user corrects a misclassification that is likely to recur.",
  inputSchema: {
    type: "object",
    required: ["name", "entity_slug", "category_slug"],
    properties: {
      name: { type: "string" },
      description_contains: { type: "string" },
      description_starts_with: { type: "string" },
      amount_min: { type: "number" },
      amount_max: { type: "number" },
      entity_slug: { type: "string" },
      category_slug: { type: "string" }
    }
  }
}

// --- ACCOUNT / SYNC TOOLS ---

{
  name: "accounts_list",
  description: "List all configured accounts with their current sync status, last sync time, and entity assignment.",
  inputSchema: { type: "object", properties: {} }
}

{
  name: "sync_run",
  description: "Trigger a manual sync for Teller accounts and/or email sources. Use when the user wants current data before a review session.",
  inputSchema: {
    type: "object",
    properties: {
      sources: {
        type: "array",
        items: { type: "string", enum: ["teller", "email_amazon", "email_venmo", "email_apple", "email_etsy", "all"] },
        description: "Which sources to sync. Omit or use ['all'] to sync everything."
      }
    }
  }
}

// --- STATUS TOOL ---

{
  name: "review_status",
  description: "Quick overview of the review queue: how many transactions are pending, held, or recently approved. Use at the start of a bookkeeping session to understand what needs attention.",
  inputSchema: { type: "object", properties: {} }
}
```

**10 tools total.** All 10 go in the in-app chat allowlist.

---

## Step 3: In-app chat allowlist

Create `src/web-chat-tools.ts` — same pattern as CFO:

```typescript
import { MCP_TOOLS } from './mcp-tools';

// All 10 tools are appropriate for in-app chat
export const TOOL_ALLOWLIST = MCP_TOOLS.map(t => t.name);
```

Since all 10 tools are under the AGENTS.md limit, no subsetting needed. If tools are added later, revisit this.

---

## Step 4: MCP server entry point

Add to `src/index.ts`:

```typescript
// MCP endpoint
if (method === 'POST' && path === '/mcp') {
  if (!requireMcpAuth(request, env)) {
    return jsonError('Unauthorized', 401);
  }
  return handleMcp(request, env);
}
```

`requireMcpAuth`: same logic as CFO — Bearer token check against `env.MCP_HTTP_KEY`, open if unset (dev only).

`handleMcp` in `src/mcp-tools.ts`:
- `initialize` → return server info with instructions
- `tools/list` → return `MCP_TOOLS`
- `tools/call` → `dispatchTool(name, args, env)`
- `notifications/initialized` → 204

Server info instructions field:
```
"Family finance agent: transaction review, spending analysis, and sync management.
Four entities: Elyse Coaching (Schedule C), Jeremy Coaching (Schedule C),
Whitford House (Schedule E), Personal/Family.
Data from Teller bank sync + Gmail email enrichment (Amazon, Venmo, Apple, Etsy).
Start a session with review_status to see what needs attention."
```

---

## Step 5: Register in fleet

Update `registry/agents.json` to add the cfo agent. Follow the same schema as existing agents. Tool names must match exactly what's in `MCP_TOOLS`.

Include the cron schedule in the registry entry.

---

## Step 6: `web-chat.ts`

Create `src/web-chat.ts` following the CFO's pattern exactly — same `runChatStream` usage, same SSE handling. The system prompt for in-app chat:

```
You are a financial assistant for Jeremy and Elyse. You help with:
- Reviewing and categorizing transactions (use review_next / review_resolve)
- Understanding spending patterns (use transactions_summary / transactions_list)
- Managing classification rules (use rules_list / rules_create)
- Running syncs to get current data (use sync_run)

Start any review session by calling review_status first.

When the user corrects a categorization and the same merchant will appear again, proactively offer to create a rule.

Amounts are displayed with credit-card sign convention: positive = expense, negative = income/refund.
```

---

## Step 7: Tool result truncation

Copy `apps/cfo/src/lib/tool-result-truncate.ts` verbatim. Apply `truncateForChat` to all tool results in `web-chat.ts` before returning to the stream — same as CFO.

---

## Acceptance Criteria

1. `POST /mcp` with a valid `initialize` call returns the correct server info
2. `tools/list` returns all 10 tools with correct schemas
3. Each tool call via `/mcp` returns a valid response (test each one)
4. In-app chat at `/api/web/chat` streams tool calls correctly
5. Agent registered in `registry/agents.json`
6. Running `review_status` returns the current queue counts
7. `review_next` → `review_resolve` flow works end-to-end via MCP
8. `sync_run` triggers a real Teller sync and email sync

---

## What Phase 1 Delivers

When Phase 1d is complete, the system can:

- Pull transactions from Teller automatically every night
- Enrich transactions with Amazon, Venmo, Apple, Etsy email context
- Auto-categorize transactions via rules and AI
- Present a review queue for human approval
- Accept bulk approvals for high-confidence batches
- Let the user drill into any transaction for context and correction
- Create rules from corrections
- Report queue status via MCP to Claude

This is the core system. Everything else (Reporting, Planning, Spending, Scenarios) builds on top of this foundation.
