# CFO Agent — Audit Report 04: Reuse, Migration, and Recommendation

Audit date: 2026-05-13
Repository: `jeremystover/AgentBuilder`
Branch: `claude/audit-cfo-agent-pBl92`
Target audience: the engineer updating the build spec for a new family financial management system on Cloudflare Workers + Neon Postgres.

This report synthesizes Reports 01–03 into specific recommendations. It is opinionated where the code is clear, and explicit where it isn't. Where the source doesn't tell me enough, I say so in Section 6 instead of inventing.

**One important factual constraint up front.** This repository contains the CFO agent's **schema and source code**, not its production data. The only `.sql` file with INSERT statements (`apps/cfo/pre-migration-backup.sql`) writes 8 rows total, all into SQLite metadata tables (`d1_migrations`, `sqlite_sequence`). The actual transaction, classification, rule, and account data lives in production D1 (`cfo-db`, id `7a8081f3-8ae5-4344-8902-5cbd7992670f`) and is not accessible from this audit. Section 3 therefore proposes export commands and field mappings; it cannot verify them against real rows.

---

## 1. What Is Worth Reusing

For each component: **adaptation effort** (COPY AS-IS / LIGHT / SIGNIFICANT) × **risk** (LOW / MEDIUM / HIGH) × **confidence** (HIGH / MEDIUM / LOW that the assessment will hold up in the new system).

### 1.1 Teller HTTP client — `apps/cfo/src/lib/teller.ts`

- **What it does:** Wraps `GET /accounts` and `GET /accounts/{id}/transactions` against `https://api.teller.io`. Handles mTLS-vs-plain `fetch` selection, Basic auth, pagination via `from_id`, error decode. Exports type definitions for `TellerAccount`, `TellerTransaction`, `TellerEnrollmentPayload`.
- **Why reuse:** 175 lines, no business-logic coupling, no DB writes. Only env-vars it reads are `TELLER_APPLICATION_ID`, `TELLER_ENV`, `TELLER_MTLS`. The two API endpoints are stable and complete enough for the use case (the CFO does not need balances, identity, or webhooks).
- **Adaptation:** LIGHT. Replace `import type { Env } from '../types'` with a narrow `TellerEnv` interface. Move into a shared package (e.g. `packages/teller`) so the new system imports it cleanly.
- **Risk:** LOW. The mTLS path requires the new system's `wrangler.toml` to declare `[[mtls_certificates]]` with the existing `certificate_id = "1c40bf07-6ba7-4e8c-b95f-27df8e7adfda"` — the cert is bound in Cloudflare, not in code, so the new Worker just needs the binding name to match.
- **Confidence:** HIGH.

### 1.2 Teller sync orchestration — `apps/cfo/src/routes/teller.ts`

- **What it does:** Enrolls accounts, pulls per-account transactions, performs pending→posted promotion, dedups, writes `transactions`/`imports`/`review_queue`/`teller_enrollments`/`accounts` in D1.
- **Why not reuse as a whole:** 439 lines tightly coupled to the CFO D1 schema. Five tables touched directly. Inserts a starter `review_queue` row with `reason='unclassified'` per new posted transaction, which is a CFO-specific UX choice.
- **What is worth extracting:**
  - The **pending→posted reconciliation algorithm** (`syncAccountTransactions` lines 94–113): "if the new posted tx matches an existing pending tx by amount + cleaned description within ±10 days, upgrade in place rather than insert a duplicate." This is a non-trivial behaviour Teller forces on integrators.
  - The **disconnect-detection pattern** (lines 405–413, 424–430): inspect error message for `enrollment.disconnected`, surface a re-link instruction.
  - The **per-enrollment imports row** wrapping a sync (`status: 'running'` → `'completed'` or `'failed' + error_message`).
- **Adaptation:** SIGNIFICANT REFACTOR. Re-author against the new Postgres schema, but copy the algorithm.
- **Risk:** MEDIUM. The pending-promotion logic has implicit assumptions (description cleanup function, ±10 day window) — easy to break in a rewrite.
- **Confidence:** HIGH that the algorithm is right; MEDIUM that all edge cases are visible in source (some Teller quirks may have been caught by hand).

### 1.3 Gmail client — `apps/cfo/src/lib/gmail.ts`

- **What it does:** OAuth refresh-token → access-token exchange, paginated message search, single-message fetch, base64url decode of multipart payloads, header lookup.
- **Why reuse:** 126 lines, no business coupling, no D1 writes. Uses three env vars (`GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`).
- **Adaptation:** LIGHT. Narrow the `Env` parameter to a `GmailEnv` interface. Better: route this through the existing fleet package `@agentbuilder/auth-google` (which currently the CFO does **not** use — see Report 02 §3d). That gives the new system a single OAuth client across the fleet matching AGENTS.md rule 5.
- **Risk:** LOW. Standard Google OAuth dance.
- **Confidence:** HIGH.

### 1.4 Email parsers — `amazon-email.ts`, `venmo-email.ts`, `apple-email.ts`, `etsy-email.ts`

- **What they do:** Pure functions `parseXEmail(message: GmailMessage) => XContext | null`. Regex- and DOM-walk-based extraction of order id / amount / items / counterparty / memo from each vendor's email format.
- **Why reuse:** No DB coupling at all. Only dependency is the `GmailMessage` shape from `gmail.ts`. Each is 100–170 lines. The parsing logic embeds vendor-specific quirks (e.g. Etsy forwarded-email handling with body date extraction; Apple's `M\d{9,}` receipt-id format; Venmo subject patterns for received/sent/charged) that took real effort to harden.
- **Adaptation:** LIGHT. Decouple the return-type imports (`VenmoContext`, `AmazonContext`, `AppleContext`, `EtsyContext` are imported from `apps/cfo/src/types.ts` — move them into a shared `email-context` types module).
- **Risk:** MEDIUM. Reliability isn't measured anywhere in the repo — there is no parse-success rate metric, only the `*_email_processed` dedup tables which intentionally mark parse failures as "processed" (Report 02 §3f). In practice the parsers will need vendor-specific touch-ups whenever the sender's HTML template changes.
- **Confidence:** HIGH for the structural reuse decision; LOW on long-term reliability without telemetry.

### 1.5 Email-to-transaction match logic — `lib/amazon.ts`, `lib/venmo.ts`, `lib/apple.ts`, `lib/etsy.ts`

- **What they do:** For each parsed email, find the most-likely matching bank transaction by amount + date proximity + description hint, score it, and either persist a `*_email_matches` row or skip.
- **Why selectively reuse:** The scoring weights (e.g. Amazon ±4/+12 days, base 50 + up to 25 for date closeness + 25 for "amazon" in description, threshold 60; Apple −2/+5 days, +40 for "apple" in description, threshold 50) are calibrated by experience.
- **What not to reuse:** The store-and-reclassify branch (`storeXMatch` → `handleClassifySingle`) is glued to the CFO classification pipeline and D1 tables.
- **Adaptation:** SIGNIFICANT for the store side; LIGHT for the match-scoring functions if extracted as pure `score(candidate, parsed) => number`.
- **Risk:** MEDIUM. Same as 1.4 — calibration is empirical, no metric in repo.
- **Confidence:** MEDIUM.

### 1.6 Dedup utilities — `apps/cfo/src/lib/dedup.ts`

- **What they do:** SHA-256 dedup hash (`accountId|postedDate|amount.toFixed(2)|description.toLowerCase().trim()`); `cleanDescription` lowercaser; quote-aware `parseCsvLine`; header-detection `parseCsv` that scans the first 10 lines and picks the row with the highest "looks like a header" score.
- **Why reuse:** Pure utilities, no env or DB coupling. The header-detection logic in particular handles the messy reality of bank/Amazon/Tiller CSV exports.
- **Adaptation:** COPY AS-IS into a shared package.
- **Risk:** LOW.
- **Confidence:** HIGH.

### 1.7 Tool-result truncation — `apps/cfo/src/lib/tool-result-truncate.ts`

- **What it does:** JSON-aware truncation for chat-bound tool outputs. Parses the result, truncates arrays to N items with a `_truncated` marker, falls back to byte-cap with a "open the SPA" hint. Tested (`tool-result-truncate.test.ts` is the only test file in the agent).
- **Why reuse:** Solves the exact problem the new MCP agent will face on day one: how to surface large analytic results to a model without blowing context.
- **Adaptation:** COPY AS-IS.
- **Risk:** LOW.
- **Confidence:** HIGH.

### 1.8 Pacific-time utility — `apps/cfo/src/lib/pacific-time.ts`

- **What it does:** SMS-dispatcher helper to test whether "now" matches a preferred local-time slot in Pacific time, DST-safe. 70 lines.
- **Why reuse:** Only matters if the new system has a similar "fire in user's local time" cron. The technique (compute Pacific offset by formatting `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`) is the right shape for the Cloudflare Workers runtime, which has Intl support.
- **Adaptation:** COPY AS-IS if the use case persists; OMIT otherwise.
- **Risk:** LOW.
- **Confidence:** HIGH conditional on the use case.

### 1.9 Twilio client — `apps/cfo/src/lib/twilio.ts`

- **What it does:** Outbound SMS via Messaging API (HTTP Basic), inbound signature verification (HMAC-SHA1 of url + sorted form params), dependency-free.
- **Why reuse:** Only matters if the new system keeps the SMS gamification subsystem (and the user's brief doesn't mention SMS).
- **Adaptation:** COPY AS-IS into a shared package.
- **Risk:** LOW for the code; the **SMS subsystem itself** (sms_persons, sms_sessions, sms_messages, sms_outcomes, sms_routing_overrides tables; `lib/sms-claude.ts` Claude reply parser; `lib/sms-variants.ts` A/B copy; `lib/sms-dispatcher.ts` cron) is a substantial feature that may not be in scope. Treat as opt-in.
- **Confidence:** HIGH on the code; OPEN on whether to keep the feature (see §6).

### 1.10 The "MCP thin wrapper over REST" pattern — `apps/cfo/src/mcp-tools.ts` (architecture, not the file)

- **What it is:** Single static `MCP_TOOLS` array (name + description + JSON Schema) + a `dispatchTool` switch that synthesizes internal `Request` objects pointed at the same REST handlers the SPA uses. The same array is re-imported by `web-chat-tools.ts` so the in-app chat shares descriptions with the MCP surface.
- **Why reuse:** Eliminates parallel implementations. Any bug fix at the REST layer applies to MCP and chat. Verified working pattern for ~10 agents in the fleet.
- **Adaptation:** COPY AS-IS as a pattern (not the specific tool list).
- **Risk:** LOW.
- **Confidence:** HIGH.

### 1.11 The "interview mode" enrichment pattern — `apps/cfo/src/lib/review-interview.ts`

- **What it does:** For one pending review item, returns the transaction + current AI suggestion + up to 8 historical classifications of the same merchant + up to 10 matching rules + up to 5 similar merchants by leading token + `queue_remaining`. One DB round trip per source.
- **Why reuse:** Best-designed tool in the catalogue (Report 03 §3.10). Self-contained, model-friendly. Generalizes to any human-in-the-loop classification problem.
- **Adaptation:** SIGNIFICANT REFACTOR (rewrite against the new Postgres schema), but keep the four-query shape and the four-section payload.
- **Risk:** MEDIUM. The `leadToken` heuristic ("first whitespace-bounded token after lowercasing and stripping punctuation") is good but bank-specific descriptions can defeat it.
- **Confidence:** HIGH on the pattern, MEDIUM on the heuristic.

### 1.12 The "learn a rule after K consistent manuals" pattern — `apps/cfo/src/lib/learned-rules.ts`

- **What it does:** After ≥3 consistent manual classifications for the same merchant and ≥90% dominance, auto-inserts a `rules` row at priority 85 with `match_field='merchant_name', match_operator='equals'`. Skips generic merchants like "amazon", "paypal" via a stop list.
- **Why reuse:** Closes the loop between manual review and future auto-categorization. ~110 lines.
- **Adaptation:** SIGNIFICANT REFACTOR (rewrite against new schema), but keep the thresholds and the generic-merchant block-list.
- **Risk:** MEDIUM. The stop list (`amazon | amzn | paypal | venmo | zelle | square | stripe | apple cash | cash app | online payment | payment | deposit | withdrawal | transfer | purchase | debit | credit`) is hard-coded — the new system should externalize this.
- **Confidence:** HIGH on the pattern.

### 1.13 Cadence proration math — `apps/cfo/src/routes/budget.ts:handleBudgetStatus`

- **What it does:** Pro-rates a budget target across cadence mismatches so a weekly query against a $600/mo target yields ~$138 expected. Period presets (`this_week | this_month | last_month | ytd | trailing_30d | trailing_90d`).
- **Why reuse:** The math is exactly the primitive a household budgeting product needs.
- **Adaptation:** SIGNIFICANT REFACTOR but copy the logic.
- **Risk:** LOW for the math; MEDIUM for the surrounding SQL (some of which assumes the CFO four-entity scope).
- **Confidence:** HIGH on the math.

### 1.14 Observability — `runCron` from `@agentbuilder/observability`

- **What it does:** Wraps every `scheduled()` invocation, writes a `cron_runs` row (+ `cron_errors` on failure) to the fleet-shared `agentbuilder-core` D1, never re-throws.
- **Why reuse:** Mandatory per AGENTS.md rule 11; the fleet dashboard depends on it.
- **Adaptation:** COPY AS-IS by importing the package.
- **Risk:** LOW. Note: this writes to the **fleet-shared D1**, not to the new agent's Postgres. That asymmetry is by design (Report 01 §1d).
- **Confidence:** HIGH.

### 1.15 Web UI auth — `@agentbuilder/web-ui-kit`

- **What it does:** Cookie-session login (`WebSessions` D1 table) + bearer `EXTERNAL_API_KEY` + `loginHtml` page + `runChatStream` for SSE chat.
- **Why reuse:** Mandatory per AGENTS.md rule 9 for any agent SPA.
- **Adaptation:** COPY AS-IS by importing. The `WebSessions` table is per-agent — you'll need it in Postgres (or keep a small D1 for sessions only; see §4).
- **Risk:** LOW.
- **Confidence:** HIGH.

### 1.16 LLM access — `@agentbuilder/llm`

- **What it does:** Tier-based model selection (`tier: 'default' | 'fast' | 'cheap'`), prompt caching defaults, `CORE_BEHAVIORAL_PREAMBLE` constant.
- **Why reuse:** Mandatory per AGENTS.md rule 6 ("Model tiers, not model ids"). The CFO violates this by hardcoding `claude-opus-4-6` in three places in `lib/claude.ts` and never importing the package despite declaring it as a dep.
- **Adaptation:** COPY AS-IS by importing — but **rewrite the CFO's `lib/claude.ts`** rather than carrying it forward (see §2.5).
- **Risk:** LOW.
- **Confidence:** HIGH.

### 1.17 Things explicitly **not** worth carrying forward as code, even if cited as "patterns"

- `lib/claude.ts` (769 lines, hardcoded model, raw `fetch`, large hand-curated merchant table baked into the system prompt).
- `lib/sms-claude.ts` (291 lines, raw `fetch`, hardcoded `claude-opus-4-6`).
- `routes/tiller.ts` (518 lines, one-time-migration tool).
- `routes/plaid.ts` + `lib/plaid.ts` (Plaid is documented as "dropped on migration" but code remains and routes/bank.ts still selects it for Patelco/EastRise — see §2.4).
- All migration files numbered `0006`, `0012` (tax-year workflow add and drop, now dead code that left `imports.tax_year` orphaned).
- `pre-migration-backup.sql` at the app root (not under `migrations/`, schema only).

---

## 2. What Should Be Rebuilt From Scratch (with rationale)

### 2.1 The D1 schema, in its entirety

- **What it is:** 21 SQL files in `apps/cfo/migrations/`. The effective schema is described table-by-table in Report 02 §1a.
- **Why rebuild:** Postgres has different idioms (real ENUM types, `numeric(12,2)` for money, `timestamptz`, native `jsonb`, partial unique indexes with proper predicates, declarative foreign-key actions). A clean Postgres schema is cheaper to write than to mechanically translate 21 SQLite migrations.
- **Specific issues to fix in the new schema** (each is a Report 02 §5e finding, restated here for action):
  - `business_entities.slug` is seeded as `airbnb` / `family` but `classifications.entity` is CHECK-constrained to `airbnb_activity` / `family_personal`. The two enums must be reconciled. Recommend: one canonical enum, one FK.
  - `classifications.category_tax` / `category_budget` are bare TEXT with no FK to `chart_of_accounts` or `budget_categories`. Use proper FKs (or proper ENUMs).
  - `category_plaid` column on `transactions` actually stores Teller's category too. Rename to `category_external` or `provider_category`.
  - `imports.tax_year` is dead (NULL for new rows since 0012). Drop.
  - Three sources of truth for tax categories: `chart_of_accounts`, `tax_categories` (0017), the constant tables `SCHEDULE_C_CATEGORIES` / `AIRBNB_CATEGORIES` / `FAMILY_CATEGORIES` in `src/types.ts`. Pick one — recommend the DB tables, keep the constants only as seed data.
  - `teller_enrollments.access_token` and `plaid_items.access_token` are plaintext TEXT. Encrypt at rest in the new system. The fleet has `@agentbuilder/credential-vault` and `@agentbuilder/crypto` packages already; the CFO does not use them.
  - Duplicate migration prefixes (`0015_cut_status` + `0015_gmail_enrollments`, `0017_apple_email_sync` + `0017_tax_categories`). Use sequential numbering in the new system.
- **What the new schema should do differently:**
  - Use real ENUM types for `entity`, `method`, `cadence`, `expense_type`, `cut_status`, `match_field`, `match_operator`, `review_status`, `review_reason`, `import_source`, `email_direction`. Migrating these is much cheaper in Postgres than in SQLite.
  - Foreign-key everything that should be FK'd. SQLite tolerates dangling references; Postgres can enforce them.
  - One classification per transaction is fine (UNIQUE on `transaction_id`), but make the audit table (`classification_history`) keyed by `(transaction_id, changed_at)` with a real timestamp index.
  - Put `merchant_name` cleanup into a generated column or a `tsvector`-indexed search column. The interview-mode "similar merchant by leading token" query (`lib/review-interview.ts`) can become a trigram match.
  - Drop `WebSessions` if you can move session storage to a shared store; otherwise keep it isolated.

### 2.2 The CFO's bookkeeping session COUNT/SELECT query

- **What it is:** The `OR (c.id IS NULL AND rq.suggested_entity IS NULL)` branch in `handleBookkeepingSession` and `handleBookkeepingBatch` (Report 03 §4c).
- **Why rebuild:** Completely-unclassified transactions show up in **every** entity's bookkeeping session. Running through all four businesses sequentially triple-counts the orphans.
- **What the new version should do:**
  - Either pre-assign every unclassified transaction to a candidate entity (e.g., by account `owner_tag` if set), or have a single "uncategorized" inbox that all four businesses share, distinct from per-business review queues.
  - Persist session state (`bookkeeping_sessions` table with progress, last_batch_offset, etc.) so a user resuming a session sees the same items.

### 2.3 `commit_bookkeeping_decisions` performance

- **What it is:** Loops up to 100 decisions, each doing 3–5 D1 queries (history insert + classification upsert + review-queue update + learn-rules query + budget-category ensure).
- **Why rebuild:** 300–500 awaited queries per commit. Postgres can do this in a single transaction with prepared statements or a CTE.
- **What the new version should do:** Bulk insert with `RETURNING`, one round trip for the upserts, one for the audit history. Learn-rule check can be deferred to a background job.

### 2.4 The Plaid integration

- **What it is:** `apps/cfo/src/lib/plaid.ts` + `apps/cfo/src/routes/plaid.ts` + Plaid columns on `accounts` and `transactions`. Documented as "dropped on migration" but `routes/bank.ts` still routes Patelco and EastRise Credit Union through Plaid.
- **Why rebuild (or replace):** The current state is inconsistent — wrangler.toml comments say Teller-only, the type system documents both, `BankProvider = 'teller' | 'plaid'`, and Plaid code is reachable. Either commit to Teller and drop Plaid entirely (Patelco/EastRise users re-link via Teller), or keep both and design them as peers.
- **What the new version should do:** Pick one provider per institution at config time, not at request time. The polymorphic `accounts` table (both `plaid_*` and `teller_*` columns) is the design tell — a normalised model would have a single `provider`, `provider_account_id`, `provider_enrollment_id` triple.

### 2.5 The Claude classification pipeline — `lib/claude.ts`

- **What it is:** 769 lines, raw `fetch` to `api.anthropic.com/v1/messages`, hardcoded `claude-opus-4-6` in three places, two-pass classifier (first pass forced tool call; second pass `web_search_20250305` server tool if confidence < 0.75), system prompt embedded in source with a large hand-curated merchant memory table.
- **Why rebuild:** Violates AGENTS.md rules 6 (model tiers, not ids) and 7 (prompt caching is on by default — implementation does enable `cache_control` but bypasses the fleet helper). Couples specific merchant facts into source.
- **What the new version should do:**
  - Import `@agentbuilder/llm` and call `llm.complete({ tier: 'default', ... })`. The package handles model selection, caching, retries, observability.
  - Move the merchant memory out of the prompt and into a `merchant_notes` table that participates in the rule-learning loop.
  - Keep the two-pass pattern (forced classify tool first, web-search fallback on low confidence). It works.
  - Prepend `CORE_BEHAVIORAL_PREAMBLE` from `@agentbuilder/llm` per AGENTS.md rule 10.

### 2.6 Legacy SPA at `/legacy`

- **What it is:** `apps/cfo/public/legacy.html` and the `[assets]`-served bundle, gated by web-ui-kit cookie auth at `/legacy`.
- **Why rebuild (or drop):** This is the pre-rewrite tax-prep UI carried over during the rename. The current React SPA at `/` covers most of its surface. Keeping it adds an auth surface and an `X-User-Id` header path that the new system shouldn't inherit.
- **What the new version should do:** Verify what `/legacy` does that `/` doesn't (the audit didn't enumerate page-by-page). If nothing essential, drop the route entirely.

### 2.7 SMS gamification subsystem (decision point, not a rebuild verdict)

- **What it is:** ~1,500 lines across `lib/sms-inbound.ts`, `lib/sms-dispatcher.ts`, `lib/sms-claude.ts`, `lib/sms-variants.ts`, `lib/sms-praise.ts`, `lib/sms-dispatcher-shared.ts`, `routes/sms.ts`. Five D1 tables. One of two cron triggers. Twilio integration.
- **Why this needs an explicit decision:** It is a substantial feature with its own surface area. The user's brief does not mention SMS. Carrying it forward into a new system is a real cost; dropping it loses a feature.
- **What the new version should do:** Either bring it forward whole (the Twilio module 1.9 + the dispatcher cron 1.8 are reusable; the schema needs rewriting per §2.1) or leave it on the old system until the new system reaches feature parity and then drop it. The auditor cannot decide this from code alone — see §6.

### 2.8 The 29-tool MCP surface

- **What it is:** Report 03 §2 inventory.
- **Why rebuild (not "carry forward"):** Three problems compound: (a) 29 tools exceed AGENTS.md rule 2's ≤10-per-agent guidance; (b) the registry says 18 — drift between source and registry; (c) several tool descriptions still say "current tax-year workflow" though that subsystem was dropped in migration 0012.
- **What the new version should do:** Curate to ≤10 tools (or split into two coherent families — see §4). Report 03 §6 has concrete proposals. The architecture (thin wrapper over REST + shared array between MCP and chat) carries forward; the specific list does not.

---

## 3. Data Migration Plan

### 3a. Caveat up front

The repository has **no production data** to inspect. I cannot validate field widths, NULL distributions, character encodings, or row counts. The plan below is structured to fail cheaply on real data: small batches, validation checkpoints, dry-run mode before commit. **Do not run any of this against production without a verified D1 export first.**

### 3b. Transactions

**Export step.** From `cfo-db`, dump the join that recreates each transaction's final state:

```sql
-- Run via wrangler d1 execute cfo-db --command "..." --json > export-transactions.json
SELECT
  t.id                          AS transaction_id,
  t.user_id,
  t.account_id,
  t.import_id,
  t.posted_date,
  t.amount,
  t.currency,
  t.merchant_name,
  t.description,
  t.description_clean,
  t.category_plaid              AS provider_category,
  t.is_pending,
  t.dedup_hash,
  t.note,
  t.plaid_transaction_id,
  t.teller_transaction_id,
  t.created_at,
  c.entity                      AS classification_entity,
  c.category_tax,
  c.category_budget,
  c.confidence                  AS classification_confidence,
  c.method                      AS classification_method,
  c.reason_codes                AS classification_reason_codes,
  c.review_required             AS classification_review_required,
  c.is_locked                   AS classification_is_locked,
  c.expense_type,
  c.cut_status,
  c.classified_at,
  c.classified_by,
  c.business_entity_id,
  c.chart_of_account_id
FROM transactions t
LEFT JOIN classifications c ON c.transaction_id = t.id
WHERE t.user_id = 'default';
```

Separately dump `transaction_splits`, `classification_history`, `attachments`, `imports`, `accounts`, `teller_enrollments` (without `access_token`), `business_entities`, `chart_of_accounts`, `rules`, `review_queue`, `budget_categories`, `budget_targets`, `income_targets`, `amazon_orders`, `amazon_transaction_matches`, `venmo_email_matches`, `apple_email_matches`, `etsy_email_matches`, `email_sync_state`, `tax_categories`. Dump each as compressed JSON for predictable casting downstream.

**Field mapping to a proposed new Postgres schema** (illustrative — the actual new schema isn't in this repo):

| Source (D1) | Target (Postgres, proposed) | Cast / cleaning |
|---|---|---|
| `t.id TEXT` | `transactions.id uuid` | Already UUIDs (`crypto.randomUUID()`); cast `text → uuid`. |
| `t.amount REAL` | `transactions.amount numeric(12,2)` | Cast via `round(amount::numeric, 2)`. SQLite REAL can drift; budget on ≤$0.01 reconciliation differences. |
| `t.posted_date TEXT` (ISO 8601) | `transactions.posted_date date` | Cast `text → date`. Reject rows that don't match `YYYY-MM-DD`. |
| `t.created_at TEXT` (`datetime('now')`) | `transactions.created_at timestamptz` | Cast `text → timestamptz`; SQLite stored UTC strings. |
| `t.dedup_hash TEXT UNIQUE` | `transactions.dedup_hash text UNIQUE` | Carry as-is. The hash includes `account_id` so it survives the account-id translation if you preserve account ids. |
| `t.category_plaid TEXT` | `transactions.provider_category text` | Rename. Misleading column name; new system can fix this. |
| `c.entity` (CHECK enum, but `business_entities.slug` uses different values) | `classifications.entity entity_enum` | **Cleaning required.** Pick one canonical set. Recommend: `elyse_coaching | jeremy_coaching | airbnb_activity | family_personal` (the classification side). Update `business_entities.slug` to match in the new schema. |
| `c.category_tax TEXT`, `c.category_budget TEXT` | `classifications.category_tax_id uuid` FK to `chart_of_accounts.id`, `classifications.category_budget_slug text` FK to `budget_categories.slug` | **Cleaning required.** Today these are bare slugs. For each row, look up the matching CoA / budget category by `(business_entity_id, code)` and populate the FK; for rows where no match exists (legacy slugs that no longer exist in any CoA — Report 02 §5e), either map to `other_expenses` / `other_personal` with a `migration_notes` column or fail loudly. |
| `c.method TEXT` (CHECK) | `classifications.method method_enum` | Direct cast. |
| `c.reason_codes TEXT` (JSON array as TEXT) | `classifications.reason_codes jsonb` | `text::jsonb` with safe fallback. Verify each row parses. |
| `c.review_required INTEGER (0|1)` | `classifications.review_required boolean` | `(review_required = 1)`. |
| `c.expense_type TEXT (NULL\|recurring\|one_time)` | `classifications.expense_type expense_type_enum NULL` | Direct. NULL means recurring per the migration comment. |
| `c.cut_status TEXT (NULL\|flagged\|complete)` | `classifications.cut_status cut_status_enum NULL` | Direct. |

**Data cleaning required** (specific to what Report 02 §5e found):

1. **Slug/enum reconciliation.** `UPDATE business_entities SET slug='airbnb_activity' WHERE slug='airbnb'; UPDATE business_entities SET slug='family_personal' WHERE slug='family';` — done once, in the export step, before mapping to FKs.
2. **Orphan classifications.** Rows where `category_tax` or `category_budget` refers to a slug that no longer exists in any chart of accounts. Generate a report (`SELECT category_tax, COUNT(*) FROM classifications WHERE category_tax NOT IN (SELECT code FROM chart_of_accounts) GROUP BY category_tax`) and decide per slug: rename, map to "other", or drop the classification (leaving the transaction unclassified for re-review).
3. **Plaintext access tokens.** Do NOT migrate `teller_enrollments.access_token` or `plaid_items.access_token` in cleartext. Re-link via Teller Connect in the new system (which gets the user a fresh token and an opportunity to audit which accounts they still want connected). See §3d.
4. **Currency consistency.** Every row has `currency='USD'` per the default; verify before assuming.
5. **`amazon_orders.product_names` / `seller_names` shape.** Stored as TEXT, sometimes JSON-encoded, sometimes a single name. Pre-normalise to JSON arrays before cast to `jsonb`.
6. **Duplicate `0015_` and `0017_` migrations.** Don't carry the migration files; the resulting schema is what matters.
7. **`imports.tax_year`.** Drop. NULL for new rows since migration 0012.

**Scope: what to migrate.**

- All `transactions` rows — they are the source of truth for cash flow and tax filing.
- All `classifications` (current state) plus `classification_history` (audit trail; tax-relevant).
- All `transaction_splits`.
- All `rules` (see §3c).
- All `accounts`, `business_entities`, `chart_of_accounts` (after slug reconciliation).
- `budget_categories`, `budget_targets`, `income_targets`.
- `amazon_orders` + `amazon_transaction_matches` (enrichment context the AI classifier reads back).
- `venmo_email_matches`, `apple_email_matches`, `etsy_email_matches` (ditto).
- `attachments` metadata (the R2 objects themselves need a separate object copy).
- `review_queue` rows with `status='pending'` (don't migrate resolved/skipped rows — they're decoration).
- `bookkeeping-notes/<userId>/<entity>.md` from R2.

**Pending transactions:** They are part of the transaction stream and exist in production at any given moment. They will be re-pulled on the new system's first Teller sync; **safe to omit** if the cutover happens during a quiet window, **migrate** if the cutover happens during pending traffic. Default: migrate them and let the new system's pending→posted promotion replace them on its next sync.

**Recommended sequence:**

1. **Snapshot** the D1 export (`wrangler d1 export cfo-db --remote --output=cfo-export-YYYYMMDD.sql`) and the R2 bucket (`wrangler r2 object` copies for `attachments/*` and `bookkeeping-notes/*`).
2. **Stage** the export into a Postgres staging database that mirrors the new schema. Do NOT load into production yet.
3. **Run cleaning passes** as `INSERT … SELECT … FROM staging.*` with `RETURNING` for verification. Each cleaning pass writes a `migration_log` row.
4. **Reconcile counts.** Row counts per table on D1 == row counts in Postgres. Sum of `transactions.amount` per `(user_id, entity, year)` matches D1. Run `transactions_summary` on both and diff.
5. **Spot-check** five Schedule C totals (one per quarter + one annual) and confirm they match the old system's output to the cent.
6. **Cutover** — see §5.

### 3c. Rules

- **Worth migrating?** Yes. Rules embed user-affirmed merchant decisions. The `learned-rules.ts` logic only creates them after ≥3 consistent manual decisions, so each row represents real human input. Throwing them away forces the user to re-decide.
- **Today's format:** `rules(id, user_id, name, match_field, match_operator, match_value, entity, category_tax, category_budget, priority, is_active, created_at)`. The CHECK constraints enumerate allowed operators (`contains | equals | starts_with | ends_with | regex`) and match fields (`merchant_name | description | account_id | amount`).
- **Field mapping** (assumes the new schema is roughly the same shape with proper FKs/enums):

| Source | Target | Notes |
|---|---|---|
| `id TEXT` | `id uuid` | Cast. |
| `user_id TEXT` | `user_id uuid` (if new system has users) or drop | If new system is single-user, drop the column. |
| `name TEXT` | `name text` | As-is. |
| `match_field TEXT` (CHECK) | `match_field match_field_enum` | Direct. |
| `match_operator TEXT` (CHECK) | `match_operator match_operator_enum` | Direct. |
| `match_value TEXT` | `match_value text` | As-is. For `match_field='amount'` rows, the value is a number serialised to text — keep as text for the comparison engine. |
| `entity TEXT` (CHECK) | `entity entity_enum` | Direct after slug reconciliation in §3b. |
| `category_tax TEXT`, `category_budget TEXT` | FK to CoA / budget_categories | Same as transactions §3b. |
| `priority INTEGER` | `priority int` | As-is. Learned rules are priority 85; the new system can keep that. |
| `is_active INTEGER (0|1)` | `is_active boolean` | Cast. |
| `created_at TEXT` | `created_at timestamptz` | Cast. |

- **Cleaning:** Same orphan-slug handling as §3b. Also re-run the `isSpecificMerchant` guard from `lib/learned-rules.ts` against each migrated rule's `match_value` — anything that fails (generic merchants like "amazon" or "paypal" that got through somehow) should be flagged for review rather than carried forward at priority 85.

### 3d. Accounts (and Teller enrollments)

- **Re-link or migrate?** Recommend **migrate the metadata, re-link the tokens.**
  - Migrate: `accounts.id`, `name`, `mask`, `type`, `subtype`, `owner_tag`, `is_active` — these are the configuration that took effort (especially `owner_tag` which the user manually assigned per account).
  - Migrate: `teller_enrollments.id`, `enrollment_id`, `institution_id`, `institution_name`, `last_synced_at` — useful for audit and for matching to fresh tokens.
  - Do **not** migrate: `teller_enrollments.access_token`, `plaid_items.access_token`. Plaintext tokens shouldn't be silently carried into a new system. Re-linking via Teller Connect lets the user audit which accounts they still want connected and gives the new system tokens minted against the new Worker's mTLS cert (or a new one).
  - Linkage: keep `accounts.teller_account_id` and `accounts.teller_enrollment_id` as the durable join key. When the user re-links, the new Teller `account_id` will be the same per-institution-per-account (Teller's IDs are stable across re-enrollments).
- **What took significant effort:**
  - `owner_tag` assignments (`set_account_owner` in MCP). Manually decided per account.
  - The `accounts.name` / `mask` / `type` / `subtype` populated from Teller — these will be re-populated automatically on re-link, so the migration is precautionary.
  - The `accounts.is_active` flag. If the user has deactivated accounts (closed cards, sunset accounts), preserve.

### 3e. What NOT to migrate

| Data | Why |
|---|---|
| `pre-migration-backup.sql` | Schema-only snapshot from the tax-prep → CFO rename. No useful content. |
| `imports.tax_year` column | NULL for all new rows since migration 0012; dead. |
| `imports` rows with `status='failed'` more than 90 days old | Operational noise; the per-failure error_message is rarely useful retrospectively. |
| `review_queue` rows with `status IN ('resolved','skipped')` | Decoration; the resolution is already in `classifications` + `classification_history`. Migrate only `status='pending'`. |
| `classification_history` rows older than 7 years | Beyond IRS retention. Optional; keep if storage is cheap. |
| `WebSessions` | Ephemeral; users will re-log in. |
| `sms_messages.twilio_payload` | Raw form bodies, debug-only per migration 0010 comment. Lossy compression OK. |
| `*_email_processed` dedup tables | Useful operationally but huge (one row per Gmail message ever seen). Migrate the message-id set as a Bloom filter or skip and accept some re-fetches in the first run on the new system. |
| `tax_year_workflows`, `tax_year_checklist_items` | Already dropped in migration 0012. Confirm they're empty before export. |
| Plaintext OAuth/access tokens | See §3d. Re-link cleanly. |
| Old `gmail_enrollments` rows | Already dropped in migration 0016. |
| The legacy SPA's user state (if any in `users.email`) | The CFO is single-user (`user_id='default'`); no real user table to migrate. |
| `agentbuilder-core.cron_runs` and `cron_errors` rows attributed to `agentId='cfo'` | Fleet-shared, not CFO-owned. Leave in place; the new agent's id will be different and its rows will accumulate cleanly. |

---

## 4. Agent Builder Integration Recommendation

### 4a. New worker inside this repo, not a separate repo

Recommend **a new `apps/<new-agent>` directory inside this monorepo**, not a separate repository. Rationale:

- The fleet pattern (one Worker per agent, shared `packages/*`, central `registry/agents.json`, reusable `_deploy-agent.yml` workflow) is the standard documented in `AGENTS.md` and is the path of least resistance.
- The shared packages the new system will need (`@agentbuilder/observability`, `@agentbuilder/web-ui-kit`, `@agentbuilder/llm`, `@agentbuilder/auth-google`) are workspace-local. Pulling them into a separate repo means publishing them, which the fleet doesn't do today.
- The dashboard reads `registry/agents.json` and the shared `cron_runs` D1. A separate repo would split that pane of glass.
- Per AGENTS.md rule 1, "never create a new agent that duplicates an existing one." If the new system replaces the CFO, the registry entry's status flips from `active` to `deprecated` (or similar) at cutover.

### 4b. Recommended wrangler.toml skeleton

A starting `apps/<new-agent>/wrangler.toml`:

```toml
name = "<new-agent>"
main = "src/index.ts"
compatibility_date = "2026-05-13"
compatibility_flags = ["nodejs_compat"]

[limits]
cpu_ms = 300000

# Inherit the CFO's cron cadence if you keep the same surface.
[triggers]
crons = ["0 9 * * *"]

# If you keep the SPA at /, you need the assets binding.
[assets]
directory = "./dist"
binding = "ASSETS"

# Fleet-shared observability D1. Same id the CFO uses.
[[d1_databases]]
binding = "AGENTBUILDER_CORE_DB"
database_name = "agentbuilder-core"
database_id = "51a422d2-e9ea-46e8-b6c8-233229434eca"

# If you keep cookie-based web auth, you still need a D1 for WebSessions.
# Either keep one D1 just for sessions OR put the WebSessions equivalent
# in Postgres via @agentbuilder/web-ui-kit's adapter (kit currently expects D1 — see §4d).
[[d1_databases]]
binding = "DB"
database_name = "<new-agent>-sessions"
database_id = "<create-with-wrangler-d1-create>"

# Postgres. Workers reach Neon over HTTPS via the @neondatabase/serverless
# driver. Connection string is a secret, not a binding:
#   wrangler secret put DATABASE_URL
# (No [[postgres]] block — there isn't one for Workers.)

# R2 for the same purposes the CFO uses it (bookkeeping notes,
# attachments, snapshots).
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "<new-agent>-files"

# Teller mTLS — reuse the existing cert if you keep the existing
# enrollments accessible from this worker.
[[mtls_certificates]]
binding = "TELLER_MTLS"
certificate_id = "1c40bf07-6ba7-4e8c-b95f-27df8e7adfda"

[vars]
DEFAULT_BANK_PROVIDER = "teller"
TELLER_ENV = "development"

# Secrets (set via wrangler secret put):
#   ANTHROPIC_API_KEY            (fleet-shared via pnpm fleet:setup-secrets)
#   DATABASE_URL                 (Neon Postgres connection string)
#   TELLER_APPLICATION_ID
#   MCP_HTTP_KEY
#   WEB_UI_PASSWORD
#   EXTERNAL_API_KEY
#   GOOGLE_OAUTH_CLIENT_ID
#   GOOGLE_OAUTH_CLIENT_SECRET
#   GOOGLE_OAUTH_REFRESH_TOKEN
```

### 4c. Connecting the new MCP agent to Agent Builder

Same pattern the CFO uses, applied carefully:

1. **Registry entry.** Add an `agents[]` entry to `registry/agents.json` with `id`, `purpose`, `kind: 'app'`, `tools[]` (the curated ≤10), `crons[]` (matching `wrangler.toml`), `secrets[]` (every secret the worker reads). The dashboard depends on this being accurate; the CFO's current entry is out of date (Report 03 §2) — don't repeat that mistake.
2. **Observability wiring.** Bind `AGENTBUILDER_CORE_DB` (id above) and route every `scheduled()` cron through `runCron(env, { agentId: '<id>', trigger, cron }, handler)`. This is mandatory per AGENTS.md rule 11.
3. **`SKILL.md`** in `apps/<new-agent>/SKILL.md` with purpose, non-goals, routing examples, and the curated tool list. Per AGENTS.md rule 3, non-goals are mandatory.
4. **Deploy workflow.** Add `.github/workflows/deploy-<new-agent>.yml` mirroring `deploy-cfo.yml` — same reusable `_deploy-agent.yml` underneath. The `d1_database` input applies if you still have a D1; otherwise leave it blank and the reusable workflow will skip the migrations step.
5. **MCP endpoint convention.** `POST /mcp` on the new Worker, `MCP_HTTP_KEY` bearer auth, JSON-RPC 2.0 — same as CFO. The Claude.ai custom-tool config points at the new worker's URL.

### 4d. Shared utilities to import, not reinvent

| Need | Use | Notes |
|---|---|---|
| Cookie session + login page + bearer EXTERNAL_API_KEY auth + SSE chat | `@agentbuilder/web-ui-kit` | `WebSessions` is currently a D1 table. The kit may not have a Postgres adapter yet — confirm before assuming. If not, keep a tiny D1 just for sessions (the schema is one table, ~10 lines). |
| Per-cron observability | `@agentbuilder/observability` (`runCron`) | Mandatory; the dashboard depends on it. |
| LLM access | `@agentbuilder/llm` | Per AGENTS.md rules 6/7/10. The CFO's not using it today; the new system should. |
| Google OAuth (Gmail) | `@agentbuilder/auth-google` | The CFO inlines OAuth refresh in `lib/gmail.ts`; the new system should consolidate per AGENTS.md rule 5. |
| Credential encryption | `@agentbuilder/credential-vault` + `@agentbuilder/crypto` | The CFO stores Teller tokens in plaintext; the new system should not. |
| Article extraction | `@agentbuilder/extract-article` | Unlikely relevant for a finance agent. |
| GitHub OAuth | `@agentbuilder/auth-github` | Not relevant. |
| Agent registry types | `@agentbuilder/registry` | Useful if the new agent self-reports its capabilities. |
| Core utilities | `@agentbuilder/core` | Inspect the contents before assuming; the CFO declares it as a dep but never imports it. |

### 4e. Recommended deploy sequence (old and new in parallel)

The deploy pipeline is path-filtered per agent (`deploy-cfo.yml` runs on `apps/cfo/**` changes, `deploy-<new>.yml` on `apps/<new>/**`). So both can ship from `main` without affecting each other. Operational sequence:

1. Land the new agent's code (no traffic) — CI deploys it, no users hit it yet.
2. Run the data migration into Neon Postgres (see §3 + §5).
3. Spot-check parity using a read-only path on the new agent (e.g., make `pnpm fleet:setup-secrets` available but don't expose the new agent's URL to the user yet).
4. Flip MCP endpoint in the user's Claude.ai custom tool from CFO's `/mcp` to the new agent's `/mcp`.
5. Pause the CFO's Teller sync cron (drop `0 9 * * *` from `apps/cfo/wrangler.toml` and re-deploy — see §5).
6. Leave CFO deployed in read-only mode for N days as a fallback (the REST + SPA surfaces still work without the cron).
7. Eventually, set the CFO registry entry status to `deprecated` and remove the Cloudflare Worker.

---

## 5. Transition Strategy

### 5a. Parallel period

Recommend **2–4 weeks parallel**, with both systems backed by the same Teller enrollments **but only one running the sync cron**.

- **Why parallel at all:** Tax-season tooling is the riskiest surface (Schedule C/E reports). If a month-end report on the new system disagrees with the old by more than rounding, you want both available for diff-and-fix.
- **Why only one cron:** If both systems pull from Teller, the user gets two copies of each transaction, two parallel categorization passes, and two diverging classification histories. Re-running `learned_rules` against two independently-categorized datasets will produce conflicting rules.
- **How to keep the old system "live" without sync:** Set `crons = []` (empty) in the CFO's `wrangler.toml`, re-deploy. The REST API, MCP, and SPA stay reachable, but the CFO stops pulling new transactions. Historical data is read-only on the old side.

### 5b. Handling the overlap window

- **Source of truth during parallel:** New system. The new system runs the daily Teller sync, classification, email enrichment.
- **What the old system is for during parallel:** Spot-checks. Compare `transactions_summary`, `pnl_all_entities`, `schedule_c_report` against the new system's equivalent for the same window.
- **Operational concern:** Both systems share the Teller mTLS cert binding (same `certificate_id`). They will appear as distinct callers to Teller. As long as only one is actively syncing (per §5a), this is fine.
- **Avoid:** Running both systems' email syncs at once. The Gmail `*_email_processed` dedup tables are per-system; whichever system processes a given message first owns it. Set the CFO's `runNightlyEmailSync` cron to empty during the overlap.

### 5c. Cutover moment

Cutover when **all four** are true:

1. New system has produced one month-end set of reports (P&L, Schedule C, Schedule E, budget status) that matches the old system within ≤$1 per category.
2. New system has run the nightly Teller + email sync for at least 5 consecutive nights without failures (visible in `cron_runs`).
3. Review queue interview mode (`next_review_item` equivalent) produces classifications the user actually accepts at ≥80% rate over the trial — same threshold as the CFO's `HIGH_CONFIDENCE_THRESHOLD`.
4. The user can answer "where are last month's transactions?" on the new system without help.

At cutover: flip the Claude.ai MCP endpoint to the new agent; flip the SPA URL the user types; stop telling the user about the old system.

### 5d. Data-loss risk and mitigation

- **Risk: Teller transactions imported into the new system before the old system is paused will exist in the old D1 with a different `transaction.id` than in Postgres.** Both copies will have the same Teller `account_id` + `transaction_id`, so `dedup_hash` will match. Mitigation: pause the CFO cron *before* running the new system's first Teller sync (§5a).
- **Risk: Classification decisions made on the old system during the migration window are lost when the cutover happens.** Mitigation: pause manual classification on the old system during the migration (i.e., don't ask the user to review queue items on the CFO while the new system is being seeded). If they do, re-export the deltas before cutover.
- **Risk: R2 attachment IDs change.** The `attachments.r2_key` strings can be reused; the R2 objects can be copied bucket-to-bucket via `wrangler r2 object`. Verify ≥1 known object opens correctly on the new bucket before declaring done.
- **Risk: Bookkeeping notes overwrite during the parallel window.** The CFO's `save_bookkeeping_notes` is last-write-wins R2 (Report 03 §3.28). During parallel, the user should only edit notes on one system; designate the new system from day 1 and don't write to R2 from the old.
- **Risk: Teller enrollment access tokens expire silently.** They are long-lived but institutions can revoke. If the user is re-linking on the new system (§3d) anyway, this risk is bounded.
- **Backup before cutover:** `wrangler d1 export cfo-db --remote --output=cfo-final-YYYYMMDD.sql` plus an R2 sync to a snapshot bucket. Retain ≥1 year (the IRS retention window is 7 years for personal returns; the snapshot doesn't need to be hot for that long).

---

## 6. Open Questions for the Human

These are questions the audit could not answer from code alone. Each affects a recommendation above.

1. **What is the new system's data model?** Section 3's field mapping is illustrative because the new Postgres schema is not in this repo. I cannot verify column widths, enum names, or FK targets until the new schema exists. **Specifically: is there one `entity` enum or are coaching, rental, and personal handled as separate tables/types?**

2. **Is the new system multi-user?** The CFO is single-user with a hardcoded `user_id='default'` and `WEB_UI_USER_ID` env var. The new system's auth model affects whether to migrate the `users` table at all, whether to expose `user_id` in MCP tool inputs, and whether the `WebSessions` table needs a per-user key.

3. **What is the "new Review module"** referenced in the brief for Report 03 §4d? I found no design doc or code for it. The shape of that module determines whether to migrate `review_queue` rows or rebuild from scratch.

4. **Is the SMS gamification feature in scope?** ~1,500 lines and 5 tables. Two answers — yes (carry forward with rewrite) or no (leave on old system, drop at cutover). Affects §2.7.

5. **Plaid: keep both providers or commit to Teller-only?** The codebase is inconsistent (Plaid documented as dropped but still wired). The user has accounts at Patelco and EastRise Credit Union currently going through Plaid. Migrating these requires either keeping the Plaid integration or asking the user to re-link via Teller (which works for some institutions but not others — Teller's institution coverage differs from Plaid's).

6. **Is the legacy `/legacy` SPA still in use?** If so, what does it do that the new SPA at `/` doesn't? Affects §2.6.

7. **What is the retention requirement for `classification_history`?** Tax records (Schedule C/E) are usually 7 years for the IRS, but the per-change history is arguably operational. Affects §3e.

8. **Will the new MCP agent be invoked via Claude.ai's custom tools (HTTP MCP) or via a different channel?** The CFO's `/mcp` is single-tenant HTTP JSON-RPC. If the new system supports more clients (Claude Desktop via SSE, Anthropic API tool use), the transport choice differs.

9. **What user ergonomics does the user want for the review/bookkeeping flow?** The CFO has two doors today (interview mode vs batched bookkeeping; Report 03 §4). The new system's UX choice changes whether to ship one tool family or two.

10. **What is the budget set being reused?** `budget_targets` are family-only today. If the new system extends per-business budgets (e.g., a $500/mo software-tooling budget for Elyse's coaching), the schema needs an `entity` column on `budget_targets`.

11. **What is the model expectation in the new system?** AGENTS.md says "model tiers, not model ids" but the CFO violates this with hardcoded `claude-opus-4-6` in three places. The new system inheriting from `@agentbuilder/llm` defaults to `tier: 'default'` — which today resolves to which model in the package?

12. **Cron schedule for the new system?** The CFO runs `0 9 * * *` (Cloudflare runs in UTC; comment says ~05:00 ET) and `*/30 * * * *` (SMS dispatcher). If SMS is dropped, the second one goes away. The first one's UTC offset will move with daylight savings — currently runs at 05:00 ET in EDT, 04:00 ET in EST. Acceptable or pin to a specific local time?

13. **What is the agent fleet roadmap?** If the chief-of-staff, research-agent, and the new finance agent will eventually share categorisation primitives or merchant memory, lifting `learned-rules.ts` and `review-interview.ts` into a shared package now is cheap. Doing it later, after divergence, is expensive.

14. **Are there obligations on data export format?** Bank statements, Schedule C reports, etc. may need to be in specific formats for the tax preparer. The CFO has `handleExport` and `handleSnapshot` in `routes/reports.ts` (not enumerated in MCP) — if the tax preparer is downstream of the old system's exports, the new system needs the same shapes.

---

End of report 04.
