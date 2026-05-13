
# CFO — Claude Code Context

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




# CLAUDE.md

Behavioral guidelines for Claude Code sessions working in this repo. Fleet conventions (rules about agents, packages, scaffolding) live in `AGENTS.md` — read both.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

**Origin:** distilled from Andrej Karpathy's January 2026 observations on LLM coding pitfalls, via the [`andrej-karpathy-skills`](https://github.com/forrestchang/andrej-karpathy-skills) CLAUDE.md.

## Runtime agents

The four bolded one-liners above are also exported from `@agentbuilder/llm` as `CORE_BEHAVIORAL_PREAMBLE`. Runtime agents (the AgentBuilder personas and any agent under `apps/*`) should prepend that constant to their system prompt. See `AGENTS.md` rule 10.
