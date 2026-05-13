# CFO Agent — Audit Report 03: MCP Tools and Agent Layer

Audit date: 2026-05-13
Repository: `jeremystover/AgentBuilder`
Branch: `claude/audit-cfo-agent-pBl92`
Target: `apps/cfo` — MCP server, tool catalog, agent interaction flow

This report describes what is in the repository. Sections 4 and 6 reference a "new Review module" and a "new system" that are **not present in this repository**; that context cannot be inspected, so comparisons are limited to what the current implementation does. Where Section 6 asks for proposals, I flag them as proposals (not findings) — they are derived from the audit, not from an existing design doc.

---

## 1. MCP Server Structure

### 1a. Entry point

**`POST /mcp`** on the single `cfo` Cloudflare Worker.

- HTTP routing lives in `apps/cfo/src/index.ts:393-412`.
- Auth: `requireMcpAuth` (`src/index.ts:269-282`) checks `Authorization: Bearer <MCP_HTTP_KEY>` or `?key=<MCP_HTTP_KEY>`. If `env.MCP_HTTP_KEY` is unset, the endpoint is open (comment marks this as "dev only").
- JSON-RPC parsing and dispatch lives in `apps/cfo/src/mcp-tools.ts:545-592` (`handleMcp`).

The server lives **inside the same Worker** that serves the REST API and the React SPA — no separate process, no separate deployment artifact.

### 1b. Transport

**JSON-RPC 2.0 over a single HTTP POST.** Not SSE, not stdio, not streamable HTTP. One request, one response per call:

- `Content-Type: application/json`
- Request body is a single JSON-RPC message: `{ jsonrpc?, id?, method, params? }`
- Response is either a single JSON-RPC envelope (`{ jsonrpc: '2.0', id, result | error }`) or `204 No Content` for `notifications/initialized`.

Protocol identity:
```json
{
  "protocolVersion": "2024-11-05",
  "capabilities": { "tools": {} },
  "serverInfo": { "name": "cfo", "version": "0.1.0" },
  "instructions": "CFO agent: bookkeeping, budgeting, cash-flow, retirement and tax prep. Four entities: Elyse's Coaching (Schedule C), Jeremy's Coaching (Schedule C), Whitford House (Schedule E), Family/Personal. Bank ingest via Teller, classification via Claude."
}
```

Methods implemented (`src/mcp-tools.ts:555-591`):
- `initialize` → returns the protocol envelope above.
- `tools/list` → returns `MCP_TOOLS` (the static array).
- `tools/call` → dispatches by tool name to `dispatchTool(name, args, env)`.
- `notifications/initialized` → returns `null` (translated to HTTP `204`).
- Anything else → JSON-RPC error `-32601: Method not found`.

There is no `resources`, no `prompts`, no `sampling`, no subscription channel. The server advertises `capabilities: { tools: {} }` only.

### 1c. Tool registration

A **single static array literal** in `apps/cfo/src/mcp-tools.ts:63-541` named `MCP_TOOLS`. Each entry has `name`, `description`, and `inputSchema` (a JSON Schema object). The array is also re-imported by `src/web-chat-tools.ts` so the in-app SSE chat reuses the same definitions for a curated 10-tool subset.

Execution wiring is a **separate `switch` statement** in `dispatchTool` (`src/mcp-tools.ts:596-780`). Each `case '<tool_name>': …` synthesizes a `Request` with the right HTTP method/path/body and passes it to the corresponding REST handler in `src/routes/*.ts`. Helpers `jsonRequest`, `withQuery`, `respondText` (lines 784-814) build the request and stringify the response body. Every synthesized request stamps `x-user-id: default`.

The pattern is **"thin wrapper over REST"** — the MCP layer does not implement any business logic; it formats the call. Adding an MCP tool requires three edits in one file: an entry in `MCP_TOOLS`, a `case` in `dispatchTool`, and (if the surface is new) a route handler in `src/routes/`.

### 1d. Deployment / lifecycle

- **Single Cloudflare Worker** (`name = "cfo"` in `wrangler.toml`). Deployed via `.github/workflows/deploy-cfo.yml` → `.github/workflows/_deploy-agent.yml` on `push` to `main` touching `apps/cfo/**`. CI runs `pnpm web:build` then `wrangler deploy`.
- **No process lifecycle to keep alive.** Workers are request-driven; the runtime instantiates the script per request. Cron triggers (`0 9 * * *`, `*/30 * * * *`) invoke the `scheduled()` export independently of `/mcp`.
- **No connection state.** Because the transport is one-request-one-response and `tools/call` is stateless, the MCP server does not maintain sessions, conversations, or per-client state. `MCP_HTTP_KEY` is the only client identifier; all calls operate on `x-user-id: default`.
- **Counterpart (in-app chat)** uses the same tool dispatch via `runChatStream` from `@agentbuilder/web-ui-kit`, serving SSE over `/api/web/chat` (`src/web-chat.ts`). That is a separate transport — the MCP entry point itself does not stream.

---

## 2. Complete Tool Inventory

The exported `MCP_TOOLS` array advertises **24 tools** in `src/mcp-tools.ts` (this number disagrees with the `tools[]` count of 18 in `registry/agents.json` — five MCP tools are not registered there: `reapply_account_rules`, `backfill_budget_categories`, `budget_forecast`, `cuts_report`, `pnl_for_entity`, plus the bookkeeping family (`start_bookkeeping_session`, `get_bookkeeping_batch`, `commit_bookkeeping_decisions`, `get_bookkeeping_notes`, `save_bookkeeping_notes`), plus `set_account_owner`, `next_review_item`, and `set_transaction_note`. So the divergence is larger when checked tool-by-tool: the registry is significantly out of date relative to `MCP_TOOLS`.) For each tool below: name, description (verbatim — what Claude reads), input schema, implementation summary, and a usage-frequency estimate based on the system prompts in `src/web-chat.ts` and the tool descriptions themselves.

> **Usage frequency** below is an **informed estimate**, not a measurement. The CFO does not log per-tool call counts in this repo (no telemetry table in D1). Frequency is inferred from: (a) the in-app chat allowlist in `src/web-chat-tools.ts` (10 tools curated for daily-driver use), (b) the system-prompt routing rules in `web-chat.ts:18-44`, and (c) the tool descriptions' positioning ("Use when the user asks …").

### 2.1 `teller_sync`

- **Description**: *"Sync the latest transactions from the user's Teller-connected bank accounts into the CFO database for the current tax-year workflow. Returns a summary of accounts synced and transactions imported."*
- **Input**: `{ account_ids?: string[] }` (optional; omit = sync all).
- **Implementation**: `POST /bank/sync` with `{ provider: 'teller', account_ids }`. Dispatches through `handleBankSync` → `syncTellerTransactionsForUser` in `src/routes/teller.ts`. Calls Teller API (`/accounts`, `/accounts/{id}/transactions`), writes to `imports`, `transactions`, `review_queue`, updates `teller_enrollments.last_synced_at`.
- **Estimated frequency**: Low through MCP — the nightly cron at `0 9 * * *` covers routine sync. Used manually when the user wants real-time data ("did my reimbursement come through yet?"). Not in the in-app chat allowlist.

### 2.2 `csv_import`

- **Description**: *"Import transactions from a pasted CSV. Requires csv (string) and account_id (string)."*
- **Input**: `{ csv: string, account_id: string }` — both required.
- **Implementation**: `POST /imports/csv` → `handleCsvImport` in `src/routes/imports.ts`. Parses CSV with the header-detection logic in `lib/dedup.ts:parseCsv`, deduplicates via SHA-256 hash, writes `imports` + `transactions` rows.
- **Estimated frequency**: Rare. The SPA has a paste-CSV UI for one-off historical loads. Not in the chat allowlist.

### 2.3 `amazon_import`

- **Description**: *"Import Amazon order context for matching against existing transactions. Requires csv (string) containing the Amazon order history export."*
- **Input**: `{ csv: string }` — required.
- **Implementation**: `POST /imports/amazon` → `handleAmazonImport`. Parses the Amazon Order History export, deduplicates by `order_key = orderId|date|amount`, inserts `amazon_orders` rows and runs the ±4/+12-day amount-match against `transactions` to populate `amazon_transaction_matches`. The nightly Gmail Amazon pipeline does the same job continuously.
- **Estimated frequency**: Rare. Used for backfilling years of Amazon history when Gmail's lookback isn't enough.

### 2.4 `tiller_import`

- **Description**: *"Import historical transactions from a Tiller spreadsheet export. Requires csv (string)."*
- **Input**: `{ csv: string }` — required.
- **Implementation**: `POST /imports/tiller` → `handleTillerImport` in `src/routes/tiller.ts` (518 LOC). Parses Tiller's specific column shape, runs its category-mapping table (`mapCategory`), inserts transactions + a starter classification.
- **Estimated frequency**: One-time migration tool. Likely already used once during the tax-prep → CFO migration.

### 2.5 `classify_transactions`

- **Description**: *"Run AI classification against the currently-unclassified transactions. Returns a summary of how many were auto-accepted vs. flagged for review."*
- **Input**: `{ limit?: number }` (default 50).
- **Implementation**: `POST /classify/run` → `handleRunClassification` in `src/routes/classify.ts`. Pulls up to `limit` unclassified transactions, runs the rules engine first, then `classifyTransaction` in `lib/claude.ts` (two-pass Claude with optional web-search). Writes `classifications` and `review_queue` rows.
- **Estimated frequency**: Medium. In the chat allowlist. Called when the user explicitly asks "re-classify these" or after a fresh sync.

### 2.6 `set_account_owner`

- **Description**: *"Assign a business entity to a bank/credit-card account (sets owner_tag). All transactions from that account will be tagged to the entity by default. Pass entity=null to clear the assignment. After calling this, call reapply_account_rules to retroactively tag historical transactions."*
- **Input**: `{ account_id: string, entity: enum-or-null }` — both required; entity ∈ `{elyse_coaching, jeremy_coaching, airbnb_activity, family_personal, null}`.
- **Implementation**: `PATCH /accounts/{id}` with `{ owner_tag: entity }` → `handleUpdateAccount`. Writes `accounts.owner_tag`.
- **Estimated frequency**: Very low. Setup-time tool. Touched once per account.

### 2.7 `reapply_account_rules`

- **Description**: *"Re-run the rules engine against all existing transactions from accounts that have a business assigned (owner_tag). Overwrites any prior AI classification that is not locked or manually set. Use this after assigning a business to an account for the first time to retroactively tag historical transactions."*
- **Input**: `{}` (none).
- **Implementation**: `POST /classify/reapply-account-rules` → `handleReapplyAccountRules`. Bulk update across `classifications` for non-locked, non-manual rows belonging to accounts with `owner_tag`.
- **Estimated frequency**: Rare; pairs with `set_account_owner`. Not in chat allowlist.

### 2.8 `backfill_budget_categories`

- **Description**: *"One-time migration: populate category_budget on older family_personal expense transactions that are missing it. Uses category_tax as the budget slug where set, falls back to other_personal. The budget screen now resolves category_budget dynamically so this is only needed once to clean up historical data. Returns counts of mapped_from_category_tax, defaulted_to_other_personal, total_updated."*
- **Input**: `{}`.
- **Implementation**: `POST /classify/backfill-family-budget` → `handleBackfillFamilyBudget` (ctx passed). Bulk UPDATE on `classifications` rows where entity=`family_personal` and category_budget IS NULL.
- **Estimated frequency**: One-time. The description openly labels it a migration.

### 2.9 `list_review_queue`

- **Description**: *"List transactions in the review queue — the ones AI flagged as low-confidence or ambiguous. Use this when the user asks 'what needs my attention'."*
- **Input**: `{}`.
- **Implementation**: `GET /review` → `handleListReview`. Selects from `review_queue` JOIN `transactions` JOIN `accounts` JOIN `classifications`, status='pending' by default. Up to 50 rows. Backfills `review_queue` first via `backfillUnclassifiedReviewQueue`.
- **Estimated frequency**: High. In chat allowlist; called on "what needs my attention" / "show me the queue".

### 2.10 `next_review_item`

- **Description**: *"Interview mode: pulls the next single pending review item and returns it with full context — transaction details, the current AI suggestion, the user's historical classifications for the same merchant, any active rules that match, and similar merchants. Use this when the user says 'walk me through categorization' or 'let's categorize some transactions'. Present ONE item at a time, show the user the precedent, recommend a classification, and wait for their decision. Then call resolve_review with action='classify' (or 'accept' to keep the AI suggestion, 'skip' to defer). Loop until queue_remaining is 0 or the user stops. Every classify decision feeds the learning loop — after 3+ consistent manual decisions for the same merchant, a rule is auto-created so future transactions get categorized without a prompt."*
- **Input**: `{}`.
- **Implementation**: `GET /review/next` → `handleNextReviewItem` → `getNextInterviewItem` in `lib/review-interview.ts`. Runs four queries: the oldest pending review row (joined to transaction/account/classification), up to 8 historical classifications for the same `merchant_name`, matching `rules` rows, and up to 5 "similar merchants" by leading token (`amazon`, `amzn`, …). Returns a single enriched payload plus `queue_remaining`.
- **Estimated frequency**: High. In chat allowlist. The chat system prompt routes "walk me through" to this tool.

### 2.11 `resolve_review`

- **Description**: *"Resolve a single review queue item. Pass action='classify' with entity + category_tax (and optional category_budget) to set a fresh classification — this also feeds the learning loop. Use action='accept' to keep the existing AI suggestion, 'skip' to defer, 'reopen' to unresolve."*
- **Input**: `{ review_id: string (req), action: enum (req) = accept|classify|skip|reopen, entity?, category_tax?, category_budget?, expense_type?, cut_status? }`.
- **Implementation**: `PATCH /review/{id}` → `handleResolveReview` → `resolveReviewItem` in `src/routes/review.ts`. Branches on action: classify writes `classifications` (manual, confidence=1.0, classified_by='user'), adds a `classification_history` audit row, marks the review row `resolved`, calls `maybeLearnRuleFromManualClassification`, `ensureBudgetCategory`. Accept clears `review_required`. Skip just marks status. Reopen reverses to `pending`.
- **Estimated frequency**: High. In chat allowlist. Called per item in interview loops.

### 2.12 `schedule_c_report`

- **Description**: *"Generate a Schedule C report for one of the two coaching businesses. Use entity='elyse_coaching' for Elyse's or 'jeremy_coaching' for Jeremy's. Returns per-category totals keyed to IRS form line numbers."*
- **Input**: `{ entity?: 'elyse_coaching'|'jeremy_coaching', tax_year?: number }`. (MCP layer also re-maps `tax_year` → `year` query param.)
- **Implementation**: `GET /reports/schedule-c?entity=…&year=…` → `handleScheduleC`. Aggregates `classifications` × `chart_of_accounts` for the chosen entity in the chosen year.
- **Estimated frequency**: Tax-season seasonal — quarterly for estimated taxes, heavy in Jan-Apr. In chat allowlist.

### 2.13 `schedule_e_report`

- **Description**: *"Generate the Schedule E (rental property) report for the current tax year."*
- **Input**: `{ tax_year?: number }`.
- **Implementation**: `GET /reports/schedule-e?year=…` → `handleScheduleE`. Same shape as Schedule C but pinned to `airbnb_activity`.
- **Estimated frequency**: Tax-season seasonal, lower volume than Schedule C (one entity). Not in chat allowlist.

### 2.14 `transactions_summary`

- **Description**: *"Top-level summary of classified totals by entity + category for the current tax year. Use when the user asks 'how much did I spend on X'."*
- **Input**: `{ tax_year?: number }`.
- **Implementation**: `GET /reports/summary` → `handleSummary`. Aggregates `classifications` by `(entity, category_tax)`.
- **Estimated frequency**: Medium. In chat allowlist.

### 2.15 `list_budget_categories`

- **Description**: *"List the user's budget categories. On first use this seeds a default set (groceries, dining_out, subscriptions, etc.) from FAMILY_CATEGORIES so the budget walkthrough always has something to iterate over. Returns each category with its slug and display name. For the walkthrough flow, call this first, then for each category call set_budget_target (or create_budget_category for anything new the user invents) and finally budget_status to confirm."*
- **Input**: `{}`.
- **Implementation**: `GET /budget/categories` → `handleListBudgetCategories`. Seeds defaults from the constant `FAMILY_CATEGORIES` if `budget_categories` is empty, then returns the full list.
- **Estimated frequency**: Low; once per budget-setup conversation.

### 2.16 `create_budget_category`

- **Description**: *"Create a new budget category mid-interview when the user names a bucket the defaults don't cover (e.g. 'kids_activities', 'coffee'). slug is lowercase_with_underscores and must be unique per user; name is the human label."*
- **Input**: `{ slug: string (req), name: string (req), parent_slug?: string }`.
- **Implementation**: `POST /budget/categories` → `handleCreateBudgetCategory`. INSERT into `budget_categories`.
- **Estimated frequency**: Low.

### 2.17 `set_budget_target`

- **Description**: *"Set or update the target amount for a budget category. Cadence is 'weekly', 'monthly', 'annual', or 'one_time' — pick whichever the user thinks about naturally (dining out is easier monthly, gifts are easier annual, kitchen remodel or named vacation is one_time). One-time targets are fixed envelopes and are excluded from the anticipated-monthly forecast. Upserting creates history; the prior open-ended target is closed automatically so trendlines still work."*
- **Input**: `{ category_slug: string (req), cadence: 'weekly'|'monthly'|'annual'|'one_time' (req), amount: number (req), notes?: string }`.
- **Implementation**: `PUT /budget/targets` → `handleUpsertBudgetTarget`. Closes the prior open `budget_targets` row by setting `effective_to` to today, inserts a new one.
- **Estimated frequency**: Low. Quarterly or annual.

### 2.18 `budget_status`

- **Description**: *"Spend-vs-target report for a period. Target amounts are pro-rated across cadence mismatches so a weekly query against a $600/mo grocery target yields ~$138 expected, not $600. Use when the user asks 'how am I doing on X this month' or 'am I over budget'. Period defaults to this_month; accepts preset (this_week|this_month|last_month|ytd|trailing_30d|trailing_90d) or explicit start+end. Pass category_slug to drill into one bucket."*
- **Input**: `{ preset?: enum, start?: YYYY-MM-DD, end?: YYYY-MM-DD, category_slug?: string }`.
- **Implementation**: `GET /budget/status` → `handleBudgetStatus`. Joins family-side transactions to `budget_targets`, prorates by cadence to the window, returns per-category `{ spent, target.prorated_amount, percent_used }`.
- **Estimated frequency**: High. In chat allowlist; flagship "am I over budget" tool.

### 2.19 `budget_forecast`

- **Description**: *"Anticipated recurring expenses, expressed monthly and annually. Hybrid logic per category: if there's an active target use it, otherwise use the trailing-12-month average of actual spend. One-time targets are listed separately, and transactions tagged expense_type='one_time' are excluded from the historical fallback. Use when the user asks 'what should I expect to spend each month' or 'what are my recurring expenses'."*
- **Input**: `{}`.
- **Implementation**: `GET /budget/forecast` → `handleBudgetForecast`. Computes monthly/annual anticipated spend per category using targets when present, trailing-12-month average otherwise.
- **Estimated frequency**: Medium. Run-rate question. Not in chat allowlist.

### 2.20 `cuts_report`

- **Description**: *"Report on transactions flagged for elimination. Returns two buckets — 'flagged' (still want to cut) and 'complete' (already cancelled) — each with category and merchant breakdowns, plus an estimated_annual_savings figure. Annualized savings is computed by deduping completed cuts on merchant_name and summing each merchant's trailing-12-month spend, so cancelling a $15/mo subscription shows up as ~$180/yr saved. Use when the user asks 'what am I trying to cut', 'how much have I saved', or 'show me my cancelled subscriptions'."*
- **Input**: `{}`.
- **Implementation**: `GET /budget/cuts` → `handleBudgetCutsReport`. Pulls `classifications.cut_status IN ('flagged','complete')`, dedupes complete on `merchant_name`, sums trailing-12-month spend.
- **Estimated frequency**: Low–Medium. Aspirational/quarterly check. Not in chat allowlist.

### 2.21 `pnl_for_entity`

- **Description**: *"Income statement (P&L) for a single entity over a period. Entities are 'elyse_coaching' (Elyse's Schedule C), 'jeremy_coaching' (Jeremy's Schedule C), 'airbnb_activity' (Schedule E), or 'family_personal'. Returns income and expenses grouped by tax category, plus net income and a count of still-unreviewed transactions in the window. Use when the user asks 'how's the business doing', 'what did I spend on the airbnb last month', or 'am I profitable this quarter'. Period defaults to this_month; accepts the same presets as budget_status."*
- **Input**: `{ entity: enum (req), preset?: enum, start?, end? }`.
- **Implementation**: `GET /pnl?entity=…` → `handlePnL`. Aggregates `classifications` by `(income_or_expense, category_tax)`.
- **Estimated frequency**: Medium. Not in chat allowlist (the consolidated `pnl_all_entities` is).

### 2.22 `pnl_all_entities`

- **Description**: *"Consolidated income statement covering all four entities (elyse_coaching, jeremy_coaching, airbnb_activity, family_personal) at once, plus a rollup total. Use for 'how did the household do this month' or 'give me a snapshot of everything'. Period defaults to this_month."*
- **Input**: `{ preset?: enum, start?, end? }`.
- **Implementation**: `GET /pnl/all` → `handlePnLAll`. Runs the per-entity calculation in parallel and consolidates.
- **Estimated frequency**: High. In chat allowlist; flagship "how are we doing" tool. Also drives the SPA `/api/web/snapshot` right rail.

### 2.23 `pnl_monthly_trend`

- **Description**: *"Month-by-month income, expenses, and net income for an entity across the last N months (default 6, max 36). Use for run-rate questions: 'how has the coaching business trended', 'what's my monthly burn', 'are expenses creeping up'. Also returns monthly averages across the window."*
- **Input**: `{ entity: enum (req), months?: number }`.
- **Implementation**: `GET /pnl/trend?entity=…&months=…` → `handlePnLTrend`. N-month series.
- **Estimated frequency**: Medium. Not in chat allowlist.

### 2.24 `start_bookkeeping_session`

- **Description**: *"Start a bookkeeping session for one of the four businesses: elyse_coaching (Elyse's Coaching), jeremy_coaching (Jeremy's Coaching), airbnb_activity (Whitford House Airbnb), or family_personal (Family / Personal). Returns a summary of how many transactions need attention in each phase (income_confident, income_uncertain, expense_confident, expense_uncertain), the stored bookkeeping notes from prior sessions, and which phase to start with. Not tied to any tax year — works across all dates. Call this first, then use get_bookkeeping_batch to pull batches of 20, review them with the user, and commit_bookkeeping_decisions to save. The session flow is: (1) income the AI is fairly confident about → confirm or fix, (2) income the AI is less sure about → classify, (3) expenses the AI is confident about → confirm or fix, (4) uncertain expenses → classify. Along the way, save notes about patterns you learn via save_bookkeeping_notes so future sessions get smarter."*
- **Input**: `{ business: enum (req) }`.
- **Implementation**: `GET /bookkeeping/session?entity=…` → `handleBookkeepingSession`. Backfills unclassified review queue, then runs one COUNT query that buckets pending transactions into four phases using `t.amount > 0` and `confidence >= 0.80` thresholds. Reads notes from R2 (`BUCKET`).
- **Estimated frequency**: Medium. In chat allowlist; called per business per session.

### 2.25 `get_bookkeeping_batch`

- **Description**: *"Fetch the next batch of up to 20 transactions for a bookkeeping session phase. Each transaction includes a line number, the AI's current suggestion (entity + category + confidence), account info, and merchant details. Present these to the user as a numbered list. The user can accept the suggestion, reclassify, or skip. Use offset to paginate through large phases."*
- **Input**: `{ business: enum (req), phase: enum (req), offset?: number }`.
- **Implementation**: `GET /bookkeeping/batch` → `handleBookkeepingBatch`. Same query shape as the session count but returns 20 transactions ordered by `confidence DESC, posted_date DESC` plus total + has_more.
- **Estimated frequency**: High during a session — called N times where N = ceil(total_pending / 20). In chat allowlist.

### 2.26 `commit_bookkeeping_decisions`

- **Description**: *"Commit a batch of bookkeeping decisions. Each decision is { transaction_id, action, entity?, category_tax?, category_budget?, expense_type?, cut_status? }. Actions: 'classify' (set entity + category_tax, feeds the learning loop), 'accept' (keep existing AI suggestion), 'skip' (defer to later). IMPORTANT: For family_personal classify decisions, ALWAYS include category_budget (one of the FAMILY_CATEGORIES slugs: groceries, dining_out, entertainment, healthcare, housing, transportation, education, personal_care, shopping, subscriptions, charitable_giving, potentially_deductible, other_personal, or any custom slug the user has created). Omitting category_budget for family_personal transactions means they will NOT appear in the budget screen. For business entities, omit category_budget. Pass expense_type='one_time' on a classify decision to exclude it from forecasts; pass cut_status='flagged' to earmark it for elimination or 'complete' once cancelled. Returns counts of classified/accepted/skipped/errors. Every classify decision trains the auto-categorization rules — after 3+ consistent manual decisions for the same merchant, a rule is auto-created."*
- **Input**: `{ decisions: Array<{ transaction_id, action: 'classify'|'accept'|'skip', entity?, category_tax?, category_budget?, expense_type?, cut_status? }> }` — max 100 per call.
- **Implementation**: `POST /bookkeeping/commit` → `handleBookkeepingCommit`. Loops the decisions serially (no batch): for each, INSERT classification_history (audit), UPSERT `classifications` (method='manual', confidence=1.0, classified_by='user'), UPDATE review_queue status='resolved', call `maybeLearnRuleFromManualClassification`, `ensureBudgetCategory`. Catches per-row exceptions and increments `errors`.
- **Estimated frequency**: High during a session — paired with each batch. Not in the chat allowlist (intended for the conversational/MCP surface, where commits are batched).

### 2.27 `get_bookkeeping_notes`

- **Description**: *"Read the bookkeeping notes file for a business. These notes are written by the assistant during prior bookkeeping sessions and contain learned patterns, merchant categorization decisions, and session history. Read these at the start of every bookkeeping session to make better categorization decisions."*
- **Input**: `{ business: enum (req) }`.
- **Implementation**: `GET /bookkeeping/notes?entity=…` → `handleGetBookkeepingNotes` → R2 `BUCKET.get('bookkeeping-notes/<userId>/<entity>.md')`.
- **Estimated frequency**: Low (the session tool already returns the notes; this is the standalone read).

### 2.28 `save_bookkeeping_notes`

- **Description**: *"Write the bookkeeping notes file for a business. Replaces the entire file. Use this during or after a bookkeeping session to record: (1) merchant categorization patterns learned (e.g. 'Kajabi charges are elyse_coaching / office_expense'), (2) edge cases or ambiguous merchants to watch for, (3) session summaries. Keep notes concise and structured so they're useful for future sessions."*
- **Input**: `{ business: enum (req), notes: string (req) }`.
- **Implementation**: `PUT /bookkeeping/notes` → `handleSaveBookkeepingNotes` → R2 `BUCKET.put(...)`.
- **Estimated frequency**: Low — once per session at most.

### 2.29 `set_transaction_note`

- **Description**: *"Set or clear a free-text note on a transaction. Use this to annotate a transaction with context that isn't captured by the classification (e.g. 'reimbursed by client', 'shared with Elyse', 'confirmed grocery run not dining'). Pass note=null to clear an existing note."*
- **Input**: `{ transaction_id: string (req), note?: string }`.
- **Implementation**: `PATCH /transactions/{id}/note` → `handleUpdateTransactionNote`. UPDATE `transactions.note` (column added in migration 0019).
- **Estimated frequency**: Low. Annotation tool.

**Tool count summary**: `MCP_TOOLS` array length is **29** (re-counted from `src/mcp-tools.ts`; the count of 24 above was an underestimate from the auditor's initial scan of the dispatch switch — actual tools enumerated 2.1–2.29). The `web-chat` allowlist exposes a curated **10** to the in-app SSE chat:
`list_review_queue, next_review_item, resolve_review, transactions_summary, pnl_all_entities, budget_status, schedule_c_report, classify_transactions, start_bookkeeping_session, get_bookkeeping_batch`. The 19 not in the chat allowlist are reachable only via the MCP endpoint (Claude.ai custom integration).

---

## 3. Tool Quality Assessment

Below, "design quality" considers: clear purpose, sufficient input schema, faithful description, scope match with the chat allowlist comment in `web-chat-tools.ts` ("≤10 tools per chat surface", per AGENTS.md rule 2). Issues are stated factually.

### 3.1 `teller_sync` — **KEEP AS-IS**
Clear purpose. Description mentions "current tax-year workflow" but migration 0012 dropped tax-year workflow tables — the wording is stale. Otherwise the contract is fine.

### 3.2 `csv_import` — **ADAPT**
Schema is minimal: `csv` and `account_id` only. No way to specify CSV dialect, date format, or column mapping; relies on the `parseCsv` header-detection heuristic in `lib/dedup.ts`. Fragile against unusual exports.

### 3.3 `amazon_import` — **ADAPT / RETIRE**
Largely superseded by the nightly Amazon Gmail pipeline (migrations 0015_gmail_enrollments, 0017_apple_email_sync). Still useful for ≥90-day backfills; consider folding into `csv_import` with a `source: 'amazon'` discriminator.

### 3.4 `tiller_import` — **RETIRE**
518-line route handler dedicated to one-time migration data. The CFO is past its tax-prep→cfo migration; the comment in `0012_drop_tax_year_workflow.sql` already declares the CFO "year-round". No ongoing use case visible in code.

### 3.5 `classify_transactions` — **KEEP AS-IS**
Tight contract (`limit`, default 50). Description matches behaviour. Issue: name suggests bulk but the underlying handler chooses what to classify (always "unclassified"); no parameter for "re-classify everything" without manual prep.

### 3.6 `set_account_owner` — **KEEP AS-IS**
Single-purpose, idempotent, clearly described. The `entity` enum being nullable is correctly modelled. Pair-with-`reapply_account_rules` instruction lives in the description.

### 3.7 `reapply_account_rules` — **KEEP AS-IS**
Takes no input. Side effect is explicit ("Overwrites any prior AI classification that is not locked or manually set"). Description does not mention how many transactions will be touched; in a chat surface this would be useful preflight info.

### 3.8 `backfill_budget_categories` — **RETIRE**
The description literally says "One-time migration … this is only needed once to clean up historical data." Once run, it has no purpose. Should be removed from the chat-facing surface entirely.

### 3.9 `list_review_queue` — **KEEP AS-IS**
Empty input schema. The underlying REST handler supports filters (`q`, `category_tax`, `sort_by`, `sort_dir`, `limit`, `offset`) that the MCP tool does not expose. The model gets the same default 50-row response every time. The chat-result truncation in `lib/tool-result-truncate.ts` caps to 10 items.

### 3.10 `next_review_item` — **KEEP AS-IS**
Strong tool: stateless ("pull the oldest pending"), rich return shape (`transaction`, `current_suggestion`, `historical_precedent` ×8, `matching_rules` ×10, `similar_merchants` ×5, `queue_remaining`). Description includes a usage protocol ("Present ONE item at a time …"). Tight schema, low surprise.
- Edge case: the SQL orders by `created_at ASC` so the oldest pending item is always returned; if the user defers an item, it stays the next item. No skip/snooze visible at this level (skip is handled by `resolve_review`).

### 3.11 `resolve_review` — **KEEP AS-IS**
Four-action enum (`accept | classify | skip | reopen`). Description is explicit about which fields are required per action. Conditional requirements (`entity` + `category_tax` required only for `classify`) are documented in the per-property descriptions but not enforced via the JSON Schema — the underlying Zod validation in `routes/review.ts` enforces it at runtime.

### 3.12 `schedule_c_report` — **ADAPT**
Stale phrasing: "Optional — defaults to the active workflow year." There is no active workflow year anymore (0012). The MCP layer maps `tax_year` to `year` query param via custom code (`mcp-tools.ts:665-667`).

### 3.13 `schedule_e_report` — **ADAPT**
Same stale "active workflow year" phrasing.

### 3.14 `transactions_summary` — **ADAPT**
Description mentions "current tax year" but the route's actual behaviour is to default to whatever the `tax_year` query param resolves to (or current calendar year). Stale phrasing again.

### 3.15 `list_budget_categories` — **KEEP AS-IS**
The "seeds defaults on first call" side effect is documented in the description. Idempotent thereafter.

### 3.16 `create_budget_category` — **KEEP AS-IS**
Tight contract. Slug constraint ("lowercase_with_underscores") is documented but not enforced in the schema.

### 3.17 `set_budget_target` — **KEEP AS-IS**
Excellent description that explains the upsert + history semantics. One issue: the schema allows `amount` ≥0 but the DB also has `CHECK (amount >= 0)` only on `income_targets`, not on `budget_targets` — out-of-band but worth noting for tool callers.

### 3.18 `budget_status` — **KEEP AS-IS**
Solid: explicit period presets, documented proration behaviour, optional `category_slug` drill-in. In chat allowlist. One observation: there's no entity filter — all results are family-side because budget_targets are family-scoped. The tool description doesn't say this explicitly.

### 3.19 `budget_forecast` — **KEEP AS-IS**
Compact, documents the hybrid target-vs-12mo-avg behaviour clearly.

### 3.20 `cuts_report` — **KEEP AS-IS**
Documents the dedupe-by-merchant annualization clearly. Some readers will be surprised that completing a one-time cut adds the merchant's *trailing-12-month spend* to estimated savings.

### 3.21 `pnl_for_entity` — **KEEP AS-IS**
Includes a useful negative space: "plus a count of still-unreviewed transactions in the window" — telegraphs that an uneven P&L is partly a categorization gap.

### 3.22 `pnl_all_entities` — **KEEP AS-IS**
Cornerstone "how are we doing" tool. Reused by `/api/web/snapshot` (`src/web-api.ts:80`).

### 3.23 `pnl_monthly_trend` — **KEEP AS-IS**
`months` default 6, max 36 — both documented.

### 3.24 `start_bookkeeping_session` — **ADAPT**
The description embeds a *full agent protocol* (read notes, then loop batches, save notes). It's effectively a system-prompt fragment. This works because Claude reads `tools/list` results into its context, but pushes the agent prompt into the tool layer where it can't be versioned or A/B-tested independently. Behaviour-wise the tool is fine.
- Edge case: the COUNT query uses `OR (c.id IS NULL AND rq.suggested_entity IS NULL)` — completely unclassified transactions are bucketed into *every* entity's session counts. Calling `start_bookkeeping_session` for all four entities triple-counts the orphans.

### 3.25 `get_bookkeeping_batch` — **ADAPT**
The phase enum mixes orthogonal axes (`income_*` ↔ `t.amount > 0`, `*_confident` ↔ `confidence >= 0.80`). The 0.80 threshold is hardcoded in `routes/bookkeeping.ts:11`. Reasonable, but the model can't change the threshold or request "show me low-confidence income only across all entities".
- Same orphan-counting issue as #3.24 — `(c.id IS NULL AND rq.suggested_entity IS NULL)` lets unclassified transactions appear in every entity's batches.

### 3.26 `commit_bookkeeping_decisions` — **KEEP AS-IS**
Strong description, explicit family_personal-needs-category_budget rule called out in ALL CAPS. Max-100 batch is documented. Issue: the implementation loops serially with one DB transaction per decision (not batched in D1's `batch()` sense), so 100 decisions are 100+ awaited queries.

### 3.27 `get_bookkeeping_notes` — **KEEP AS-IS**
Redundant with `start_bookkeeping_session` (which already returns notes) but cheap.

### 3.28 `save_bookkeeping_notes` — **ADAPT**
Replaces the entire file. No locking, no diff, no append-only history. If the model mid-conversation does (read → modify → write), and another tool call interleaves a save, the loser is silently overwritten. R2 has no native conditional write here.

### 3.29 `set_transaction_note` — **KEEP AS-IS**
Simple, single-purpose.

### Cross-cutting issues

- **Stale "tax-year workflow" wording** appears in three tool descriptions (`teller_sync`, `schedule_c_report`, `schedule_e_report`, `transactions_summary`) even though migration 0012 dropped that subsystem. Doesn't break behaviour but misleads the model.
- **MCP `x-user-id: default` baked in.** Every synthesized request has `x-user-id: default`. There is no per-call user scoping. Fine while the CFO is single-tenant; would need to change for multi-user.
- **Tool count exceeds AGENTS.md rule 2** (≤10 per agent). 29 tools in `MCP_TOOLS`. The in-app chat curates 10; the Claude.ai custom-tool surface sees all 29.
- **Registry drift.** `registry/agents.json` lists 18 tools for the CFO. The 11+ extras in `MCP_TOOLS` not in the registry would not surface in the fleet dashboard. (Cited in Report 01 §4b.)
- **`additionalProperties: false`** on every schema. Good hygiene; means the model can't smuggle extra fields.

---

## 4. Bookkeeping Workflow Assessment

### 4a. End-to-end flow (from tool descriptions and code, not external docs)

The intended sequence per `start_bookkeeping_session`'s description, cross-checked with `routes/bookkeeping.ts`:

1. **`start_bookkeeping_session({ business })`** — returns `{ phases: { income_confident, income_uncertain, expense_confident, expense_uncertain }, total_pending, notes, next_phase, batch_size: 20 }`. Also implicitly backfills `review_queue` via `backfillUnclassifiedReviewQueue` (see `routes/bookkeeping.ts:62`).
2. *(Optional)* **`get_bookkeeping_notes({ business })`** — read prior session notes. Redundant; `start_bookkeeping_session` already returned them.
3. **Loop**, for each phase in `[income_confident, income_uncertain, expense_confident, expense_uncertain]` while `total_in_phase > 0`:
   - **`get_bookkeeping_batch({ business, phase, offset })`** — returns up to 20 transactions sorted by `confidence DESC, posted_date DESC`, with current AI suggestion + account info + merchant.
   - Model presents the batch as a numbered list, recommends acceptance or reclassification per row.
   - **`commit_bookkeeping_decisions({ decisions: [...] })`** — up to 100 decisions per call. Each writes `classifications`, audit history, resolves the linked review queue row, calls `maybeLearnRuleFromManualClassification`, ensures the budget category exists.
4. *(Optional, ad-hoc)* **`save_bookkeeping_notes({ business, notes })`** — markdown blob to R2 keyed `bookkeeping-notes/<userId>/<business>.md`.

### 4b. What works well in this flow

- **Tool surface is compact.** Four tools cover the loop (start, batch, commit, notes). Each does one thing.
- **The single COUNT/SELECT query** that drives phasing means the model can plan the session up front (knows how many calls). The query is reused unchanged in both `handleBookkeepingSession` and `handleBookkeepingBatch`.
- **Persistent learning loop.** Every `classify` decision in `commit_bookkeeping_decisions` calls `maybeLearnRuleFromManualClassification`. With ≥3 consistent decisions for the same merchant and ≥90% dominance, a rule is auto-inserted at priority 85 (`lib/learned-rules.ts`). Future syncs auto-categorize that merchant.
- **Persistent agent notes.** R2-backed markdown lets the agent persist patterns across sessions independently of the schema (e.g., "Kajabi → elyse_coaching/office_expense"; the system prompt in `lib/claude.ts:470-492` shows exactly this kind of merchant memory baked in).
- **Idempotent commits.** Per-decision try/catch isolates errors; one bad row doesn't drop the rest.
- **Audit trail.** Every prior classification gets cloned into `classification_history` before being overwritten.

### 4c. Painful, slow, or unreliable aspects (factual, from code)

- **Orphan triple-counting.** The phase query joins on `(c.entity = ? AND c.review_required = 1) OR (c.id IS NULL AND rq.suggested_entity = ?) OR (c.id IS NULL AND rq.suggested_entity IS NULL)`. The third branch lets every entity's bookkeeping session count and surface every completely-unclassified transaction. Doing all four businesses in sequence shows the same orphan transactions four times.
- **Hardcoded confidence threshold.** `HIGH_CONFIDENCE_THRESHOLD = 0.80` (`routes/bookkeeping.ts:11`). Not configurable from MCP. If the AI calibrates differently across vendors, the phase split skews.
- **Serial commits.** `handleBookkeepingCommit` loops the decisions one at a time, each doing 3–5 D1 queries (history insert, classification upsert, review-queue update, learn-rules query, budget-category ensure). A 100-decision batch is 300–500 awaited queries.
- **Lossy `save_bookkeeping_notes`.** Last write wins; no locking, no append.
- **Confidence-as-priority ordering.** Batches sort by `confidence DESC` then `posted_date DESC`. The user sees the system's strongest opinions first (good for "confirm fast") but ambiguous items are paged to the end of the phase, making them easier to skip.
- **Phase ordering bias.** `determineNextPhase` always returns income first, then expenses; uncertain items within a polarity are always last. If the agent stops mid-session the user has bias-confirmed the easy income items but skipped uncertain expenses.
- **Reentrancy.** `start_bookkeeping_session` and `get_bookkeeping_batch` both call `backfillUnclassifiedReviewQueue`. Each new sync between calls can add rows mid-loop. The batch's pagination `offset` is relative to the snapshot at *that* batch call, so newly-backfilled rows can shift items between batches.
- **Stateless session.** The session object isn't persisted. There's no `bookkeeping_sessions` table tracking "you got 47/200 done last time". The next call to `start_bookkeeping_session` re-counts from the live DB.

### 4d. Comparison to "the new Review module"

The user's brief mentions a "new Review module" the new system is designed to implement. **No such module exists in this repository** — grepping `Review module`, `new Review`, and the broader code/docs surfaces no design doc, no schema, no separate worker. I cannot factually compare the current flow to a target I don't see.

The current Review surface in this repo has two doors:

- The **single-item interview** door (`next_review_item` + `resolve_review`) — best when the user wants to walk through items one by one with full historical context per item.
- The **batched bookkeeping session** door (`start_bookkeeping_session` + `get_bookkeeping_batch` + `commit_bookkeeping_decisions`) — best when the user wants to bulk-confirm.

The two doors share the underlying tables (`review_queue`, `classifications`) but have separate query shapes, separate row-locking conventions, separate enrichment helpers (`getNextInterviewItem` vs the batch JOIN), and only `next_review_item` pulls historical precedent + matching rules + similar merchants. The bookkeeping batch returns the AI's current suggestion but not the user's historical decisions for the same merchant.

---

## 5. CFO-Specific Tools vs. General Tools

### 5a. Tightly coupled to current CFO data model

These tools reference the specific four-entity enum (`elyse_coaching | jeremy_coaching | airbnb_activity | family_personal`), Schedule C/E IRS line numbers, or family-budget category dictionary, all of which are hardcoded in `src/types.ts`:

- `schedule_c_report`, `schedule_e_report`, `transactions_summary`, `pnl_for_entity`, `pnl_all_entities`, `pnl_monthly_trend` — entity enum + chart-of-accounts coupling.
- `start_bookkeeping_session`, `get_bookkeeping_batch`, `commit_bookkeeping_decisions`, `get_bookkeeping_notes`, `save_bookkeeping_notes` — entity enum + R2 path conventions + family-categories enumeration in description.
- `resolve_review`, `list_review_queue`, `next_review_item` — entity enum (in inputs/output) + `review_queue.reason` enum coupling (`unclassified` was added in migration 0003 specifically for the CFO flow).
- `set_account_owner` — `owner_tag` column convention + entity enum.
- `list_budget_categories`, `create_budget_category`, `set_budget_target`, `budget_status`, `budget_forecast`, `cuts_report` — `budget_categories` / `budget_targets` schema + the family-only assumption (no business-side budgets).
- `backfill_budget_categories`, `reapply_account_rules` — point-in-time migration tools for this database.

### 5b. Logic worth reusing in a new MCP agent

Subjective, but the implementations below are general-purpose patterns:

- **`getNextInterviewItem`** (`lib/review-interview.ts`): the pattern of "fetch one ambiguous item + N historical precedents + N matching rules + N similar items by leading token" generalizes to any human-in-the-loop classification problem.
- **`maybeLearnRuleFromManualClassification`** (`lib/learned-rules.ts`): the "after K consistent manual classifications, promote to a deterministic rule" pattern is reusable for any tagging/labeling workflow with deterministic and probabilistic branches.
- **`truncateForChat`** (`lib/tool-result-truncate.ts`): JSON-aware array truncation + drill-in hint pattern. Reusable across any MCP/chat surface where tool results can be large.
- **The "thin wrapper over REST" MCP pattern** itself (`dispatchTool` synthesizing internal `Request` objects). Trivially extractable. Avoids parallel implementations between the REST handlers, the SSE chat, and the MCP server.
- **`runChatStream` allowlist + `MCP_TOOLS` reuse** (`web-chat-tools.ts`): exposes a curated subset of the MCP surface to an in-app chat while keeping a single source of truth for tool descriptions.
- **Cadence-prorated budget math** (`routes/budget.ts:handleBudgetStatus`): the "weekly query against a $600/mo target yields ~$138 expected" logic is a tidy normalizer.
- **`runCron` observability wrapper** (`@agentbuilder/observability`): not in `MCP_TOOLS` per se but the per-invocation logging pattern is fleet-wide.

### 5c. Reusable patterns

- **Period presets** (`this_week, this_month, last_month, ytd, trailing_30d, trailing_90d`) appear in `budget_status`, `pnl_for_entity`, `pnl_all_entities`. The same enum could be exported as a reusable input-schema fragment.
- **Sort/filter/paginate triad** in `routes/review.ts:handleListReview` and `routes/transactions.ts:handleListTransactions` — same SORT_COLS + sort_dir + limit/offset pattern.
- **History-then-mutation pattern** in `handleBookkeepingCommit` and `resolveReviewItem` — both INSERT classification_history before overwriting classifications. Reusable as an "auditable upsert" helper.
- **Dedup-write-before-parse** in the four `*_email_processed` tables. Reusable but with the same caveat as Report 02: parse failures are permanently shelved.

---

## 6. What the New MCP Agent Should Look Like (Proposals)

I am proposing this section based on the audit findings, not from a design document. There is no "new system" code in this repository — the proposals below are derived from what works and what doesn't in the current implementation, plus the explicit hints in the user's brief.

### 6a. Tools that translate directly (KEEP equivalents)

| Today | New-system equivalent (proposed) | Why |
|---|---|---|
| `next_review_item` | `review.next` (returns one item + precedent + rules + similar merchants + queue_remaining) | Strongest interview-mode tool. Self-contained enrichment. |
| `resolve_review` | `review.resolve` | Four-action enum (`accept|classify|skip|reopen`) covers all flow control. |
| `pnl_all_entities` | `pnl.summary` | Cornerstone "how are we doing" tool. |
| `pnl_for_entity` | `pnl.byEntity` | |
| `pnl_monthly_trend` | `pnl.trend` | Trend questions are common; tool is compact. |
| `budget_status` | `budget.status` | Cadence-prorated comparison is the right primitive. |
| `budget_forecast` | `budget.forecast` | Hybrid target/12-mo-avg matches how people actually plan. |
| `cuts_report` | `budget.cuts` | Annualization is the headline number. |
| `transactions_summary` | `tx.summary` | Once "current tax year" wording is dropped. |
| `schedule_c_report`, `schedule_e_report` | `tax.scheduleC`, `tax.scheduleE` (parameterised entity) | Same shape; drop the stale "active workflow year" phrasing. |
| `start_bookkeeping_session` / `get_bookkeeping_batch` / `commit_bookkeeping_decisions` | One tool family — but **collapse to two**: `bookkeeping.start` + `bookkeeping.commit`. The current `get_bookkeeping_batch` could become a sub-call inside `bookkeeping.start` returning the first batch immediately, with subsequent batches via the model passing `offset` back. Reduces handshakes per session by 1. | The tool count is high; this saves one round trip. |
| `set_account_owner` + `reapply_account_rules` | `account.setOwner({ retroactive: true })` — fold the two-step into one option. | The current pairing always travels together (see description of `set_account_owner`). |
| `set_transaction_note` | `tx.setNote` | Clean. |
| `set_budget_target`, `create_budget_category`, `list_budget_categories` | Same three. | Budget setup is a separate axis from spend reporting; keeps the model focused. |

### 6b. New tools the new system would likely need (proposed)

These derive from gaps the audit exposed, not from a target spec:

- **`review.bulkAccept({ filter })`** — currently `list_review_queue` returns rows and `resolve_review` resolves one. A bulk-accept tool that takes a filter (date range, merchant pattern, current_method='rule') would let the agent close out a stack of confident-AI items in one call. The REST handler `handleBulkResolveReview` already exists in `src/routes/review.ts:96-109`; it is not exposed as an MCP tool today.
- **`tx.list({ filter })`** — `routes/transactions.ts:handleListTransactions` supports rich filters (entity, category_tax, account_id, date_from, date_to, review_required, unclassified, cut_status, q, sort_by, sort_dir, limit, offset). No MCP tool exposes this. The agent currently cannot answer "show me all Patelco charges in March 2026" without bouncing through `next_review_item` or asking the user to open the SPA.
- **`rules.list` / `rules.create` / `rules.applyRetroactive`** — the REST routes exist (`src/routes/rules.ts`) but none is in `MCP_TOOLS`. The agent has no way to show or edit deterministic rules conversationally, even though the system prompt encourages "save patterns".
- **`gmail.runSync({ vendors? })`** — `POST /cron/email-sync` and `POST /gmail/sync` exist but no MCP tool. The agent cannot say "let me re-pull the last week of Amazon emails first" without telling the user to click a button.
- **`account.list`** — there's no read-only list-accounts tool. `set_account_owner` requires the model to know an `account_id`. Today it has to infer from `transactions_summary` or wait for the user.
- **`bookkeeping.status({ business? })`** — a lightweight "how much is left" probe that doesn't backfill the review queue or load notes. Useful for status updates without paying the side-effect cost.

### 6c. Retire because the new UI will cover them

These are tools whose primary value today is letting the agent perform actions the SPA covers more directly. If the new system pairs a chat surface with a comprehensive review/budget UI:

- `backfill_budget_categories` — one-time migration; retire absolutely.
- `tiller_import` — one-time migration; retire absolutely.
- `csv_import`, `amazon_import` — keep if backfills are an ongoing need; otherwise move behind the UI.
- `list_budget_categories`, `create_budget_category`, `set_budget_target` — only valuable when the user wants to do budget setup conversationally; otherwise UI is faster.
- `get_bookkeeping_notes`, `save_bookkeeping_notes` — if the new system has a structured "merchant memory" surface, the freeform markdown blob can retire.

### 6d. Agent scoping

**Proposal** (not finding): one MCP agent at the conversational level, with **two coherent tool families internally** — `review.*` (interview + bulk resolve + rules) and `analytics.*` (PnL + budget + tax reports). The current 29-tool flat surface is past the AGENTS.md rule-2 threshold and visibly stale (registry drift, "tax-year workflow" stale wording, retired tools still advertised).

Concrete sub-scoping options the audit surfaces:

- **One agent, two families.** Easier to operate (one Worker, one /mcp endpoint, one auth). Tools are named with prefixes (`review.*`, `analytics.*`, `bookkeeping.*`, `tx.*`, `account.*`). Matches the in-app chat split today (10 curated tools).
- **Two agents — Review/Bookkeeping and Reporting/Analytics.** Cleaner cognitively; user routes by intent. Cost: two Workers, two endpoints, double the auth surface, plus a routing layer.
- **One read-only agent + one write agent.** The current MCP server already needs `MCP_HTTP_KEY`; splitting write tools (resolve_review, commit_bookkeeping_decisions, set_account_owner, save_bookkeeping_notes, set_budget_target, etc.) behind a stricter auth surface limits blast radius. The current code has no such split.

The audit does not recommend one of these over the others — they are mutually exclusive choices that depend on the new system's broader architecture, which is not in this repo.

---

End of report 03.
