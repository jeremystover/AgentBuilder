# Family Finance — Claude Code Context

This file lives at `apps/cfo/CLAUDE.md`. Read it at the start of every session working on this app.

-----

## What This Is

A family financial management SaaS application — a complete rebuild of the CFO agent at this same path (`apps/cfo/`). The old CFO code may still be present on the `main` branch as a reference; this build lives on a separate branch.

Six modules sharing one Postgres database:

1. **Gather** — pull transactions from Teller, Gmail (Amazon/Venmo/Etsy/Apple), Chrome extension
1. **Review** — triage, auto-categorize, human-approve transactions
1. **Planning** — forward-looking financial plans with income/expense targets
1. **Spending** — actuals vs. plan comparison and visualization
1. **Scenarios** — balance sheet, account projections, tax modeling, long-range scenario analysis
1. **Reporting** — generate Schedule C/E and summary reports to Google Drive

Full spec: `docs/family-finance-spec.md`
Scenarios supplemental: `docs/cfo-scenarios.md`

-----

## Stack

- **Runtime:** Cloudflare Workers (same as all agents in this monorepo)
- **Database:** Neon (serverless Postgres) via Cloudflare Hyperdrive binding `HYPERDRIVE`
- **File storage:** R2 binding `STORAGE`
- **Queue:** Cloudflare Queue binding `SCENARIO_QUEUE` (for async scenario runs)
- **Assets:** Vite-built React SPA via `[assets]` binding `ASSETS`
- **Auth:** `@agentbuilder/web-ui-kit` (cookie session — same as CFO agent)
- **Gmail:** `@agentbuilder/auth-google` (NOT raw GOOGLE_OAUTH_* env vars)
- **LLM:** `@agentbuilder/llm` with model tiers (NOT hardcoded model IDs)
- **Observability:** `@agentbuilder/observability` for cron logging
- **Frontend:** React 18 + TypeScript + Vite + Tailwind 3 + Lucide + Sonner

-----

## Repository Integration

This app is `apps/cfo/` in the AgentBuilder pnpm monorepo. It is a rebuild of the previous CFO agent at the same path. The CI workflow (`deploy-cfo.yml`) and the wrangler `name = "cfo"` are unchanged. When in doubt about a monorepo pattern, the old CFO code on `main` is a reference — then apply the corrections listed below.

**Two corrections vs. the old CFO that this app always makes:**

1. Gmail auth uses `@agentbuilder/auth-google` — never raw `GOOGLE_OAUTH_*` env vars
1. LLM calls use `@agentbuilder/llm` tiers — never hardcoded model IDs like `claude-opus-4-6`

-----

## Critical Architecture Rules

**Email is Gather-only.** Email enrichment adds context to staged transactions. It never sets classification state, triggers review completion, or marks anything approved. The Review module owns all approval decisions. This is different from how the CFO agent works — do not replicate the CFO’s coupled approach.

**Raw payloads are temporary.** The `raw_transactions` staging table stores full JSON payloads from Teller and email. Once a transaction is approved and written to `transactions`, a background job nulls out the `raw_payload` column. This keeps Neon storage within the free tier.

**Single-category model.** Each transaction has one category — either a tax category (Schedule C/E line) or a personal budget category. There is no `category_tax` + `category_budget` dual-column model like the CFO uses. Simplification is intentional.

**Scenarios run async.** The projection engine is a Cloudflare Queue consumer. It never runs inline in a request handler. Status is polled via `GET /api/scenarios/:id/status`.

-----

## What NOT to Do

- Do not copy the CFO’s `src/routes/classify.ts` — classification architecture is different here
- Do not implement SMS features — dropped entirely
- Do not implement Plaid — Teller only (some accounts handled manually)
- Do not copy `review_queue` table design from CFO — new review flow is different
- Do not use `x-user-id` header for multi-tenancy — this system has two named users (Jeremy + Elyse), same permissions, handled via session
- Do not hardcode entity names or category slugs in application logic — all configurable
- Do not write period-by-period to the database during scenario runs — accumulate in memory, write the full snapshot as one transaction at the end

-----

## Existing Code Worth Reusing

**From `apps/cfo/` — adapt these:**

- `src/lib/teller.ts` → promoted to `packages/teller` (or copied inline until promoted)
- `src/lib/dedup.ts` → copy as-is (pure utilities)
- Teller pending→posted reconciliation algorithm in `src/routes/teller.ts` lines 94–113
- Teller disconnect-detection pattern in `src/routes/teller.ts` lines 405–413
- `src/lib/review-interview.ts` → `getNextInterviewItem` pattern (adapt to new schema)
- `src/lib/learned-rules.ts` → `maybeLearnRuleFromManualClassification` pattern (adapt)
- `src/lib/tool-result-truncate.ts` → copy as-is
- `dispatchTool` MCP pattern from `src/mcp-tools.ts` → apply to new tool set

**From `apps/cfo/src/web/` — copy verbatim:**

- `tailwind.config.ts` (update content glob only)
- `src/web/index.css`
- `src/web/main.tsx`
- `src/web/components/ui.tsx` (Button, Card, Badge, Select, Input, Drawer, PageHeader, EmptyState)
- `src/web/router.ts` (replace RouteId enum with new routes)
- `src/web/utils/txColor.ts`
- `src/web/components/TopNav.tsx` (replace TABS array and brand mark)
- `src/web/components/ChatPanel.tsx` (rebind streaming format)

**From `apps/cfo/src/web/` — use as layout reference, rewrite implementation:**

- `ReviewQueueView.tsx` — preserve the bulk-selection pattern and filter panel layout exactly
- `BudgetView.tsx` — preserve the SummaryStat grid and progress bar patterns
- `ReportsView.tsx` — preserve the IRS-line table structure

**Email parsers in `apps/cfo/src/lib/`** (`amazon-email.ts`, `venmo-email.ts`, `apple-email.ts`, `etsy-email.ts`) — read these as reference for vendor quirks, but rewrite against the new gather-only architecture. Do not copy the classification side effects.

-----

## Users

Two users: Jeremy and Elyse. Same permissions. No role differentiation. The `web_sessions` table (via `@agentbuilder/web-ui-kit`) handles auth.

-----

## Design System (Brief)

Light “ledger paper” theme. Indigo accent for consistency with other agents.

|Token           |Value                             |
|----------------|----------------------------------|
|`bg-primary`    |`#F8FAFC` (page background)       |
|`bg-surface`    |`#FFFFFF` (cards)                 |
|`bg-elevated`   |`#F1F5F9` (table headers, pressed)|
|`border`        |`#E2E8F0`                         |
|`text-primary`  |`#0F172A`                         |
|`text-muted`    |`#64748B`                         |
|`accent-primary`|`#4F46E5` (indigo)                |
|`accent-success`|`#059669`                         |
|`accent-warn`   |`#D97706`                         |
|`accent-danger` |`#DC2626`                         |

Body text is `text-sm`. No dark mode. No web fonts — system stack.