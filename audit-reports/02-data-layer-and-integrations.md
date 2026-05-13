# CFO Agent — Audit Report 02: Data Layer and Integrations

Audit date: 2026-05-13
Repository: `jeremystover/AgentBuilder`
Branch: `claude/audit-cfo-agent-pBl92`
Target: `apps/cfo` — D1 schema, Teller and email integrations, data migration assessment

This report describes what is in the repository as of this snapshot. No fixes, suggestions, or value judgements unless explicitly framed as observations.

---

## 1. Database Schema

The CFO app is bound to **two** D1 databases (per `apps/cfo/wrangler.toml`):

- `DB` → `cfo-db` (`7a8081f3-8ae5-4344-8902-5cbd7992670f`) — the agent's own store.
- `AGENTBUILDER_CORE_DB` → `agentbuilder-core` (`51a422d2-e9ea-46e8-b6c8-233229434eca`) — fleet-shared observability store. The CFO does not own its schema; `@agentbuilder/observability`'s `runCron` writes to it (`cron_runs`, `cron_errors`) but no migrations or `CREATE TABLE` statements for that DB live in `apps/cfo/migrations/`.

The remainder of this section describes `cfo-db`, reconstructed from the 21 SQL files in `apps/cfo/migrations/`.

### 1a. Effective schema (after all migrations applied)

Tables grouped by domain. Indexes are inline.

#### Identity / org

**`users`** *(0001)*
- `id TEXT PRIMARY KEY`, `email TEXT UNIQUE NOT NULL`, `name TEXT`, `created_at TEXT DEFAULT (datetime('now'))`, `updated_at TEXT DEFAULT (datetime('now'))`

**`business_entities`** *(0001; renamed in 0005, 0008)*
- `id TEXT PRIMARY KEY`, `user_id TEXT NOT NULL → users.id ON DELETE CASCADE`, `slug TEXT NOT NULL`, `name TEXT NOT NULL`, `entity_type TEXT CHECK IN ('schedule_c','schedule_e','personal')`, `tax_year INTEGER`, `created_at`
- `UNIQUE(user_id, slug)`
- Migration 0005 renames the airbnb entity's name to `Whitford House`. Migration 0008 renames `coaching_business` → `elyse_coaching` and seeds a parallel `jeremy_coaching` entity for each user.

**`chart_of_accounts`** *(0001)*
- `id TEXT PRIMARY KEY`, `business_entity_id TEXT → business_entities.id ON DELETE CASCADE`, `code TEXT NOT NULL`, `name TEXT NOT NULL`, `form_line TEXT`, `category_type TEXT DEFAULT 'expense' CHECK IN ('income','expense')`, `is_deductible INTEGER DEFAULT 1`, `created_at`
- `UNIQUE(business_entity_id, code)`
- Seeded by `POST /setup` from the constant tables `SCHEDULE_C_CATEGORIES`, `AIRBNB_CATEGORIES`, `FAMILY_CATEGORIES` in `src/types.ts`.

**`tax_categories`** *(0017_tax_categories)* — alternate, user-editable category table
- `id TEXT PRIMARY KEY`, `user_id TEXT NOT NULL`, `slug TEXT NOT NULL`, `name TEXT NOT NULL`, `form_line TEXT`, `category_group TEXT CHECK IN ('schedule_c','schedule_e')`, `is_active INTEGER DEFAULT 1`, `created_at`
- `UNIQUE(user_id, slug)`
- This table coexists with `chart_of_accounts` and the inlined category dictionaries in `src/types.ts`; the audit did not verify which surface is canonical.

#### Bank-provider linking

**`plaid_items`** *(0001)*
- `id TEXT PRIMARY KEY`, `user_id → users.id ON DELETE CASCADE`, `item_id TEXT UNIQUE NOT NULL`, `access_token TEXT NOT NULL`, `institution_id TEXT`, `institution_name TEXT`, `cursor TEXT`, `last_synced_at TEXT`, `created_at`

**`teller_enrollments`** *(0002)*
- `id TEXT PRIMARY KEY`, `user_id → users.id ON DELETE CASCADE`, `enrollment_id TEXT UNIQUE NOT NULL`, `access_token TEXT NOT NULL`, `institution_id TEXT`, `institution_name TEXT`, `last_synced_at TEXT`, `created_at`
- `INDEX idx_teller_enrollments_user(user_id)`

**`accounts`** *(0001; +columns in 0002)*
- `id TEXT PRIMARY KEY`, `plaid_item_id TEXT → plaid_items.id ON DELETE SET NULL`, `user_id → users.id ON DELETE CASCADE`, `plaid_account_id TEXT UNIQUE`, `name TEXT NOT NULL`, `mask TEXT`, `type TEXT`, `subtype TEXT`, `owner_tag TEXT`, `is_active INTEGER DEFAULT 1`, `created_at`, `teller_enrollment_id TEXT`, `teller_account_id TEXT`
- `UNIQUE INDEX idx_accounts_teller_account_id WHERE teller_account_id IS NOT NULL`
- `INDEX idx_accounts_teller_enrollment(teller_enrollment_id)`
- Note: the `teller_enrollment_id` column was added by ALTER but no explicit FK constraint to `teller_enrollments` is declared.

#### Ingestion / transactions

**`imports`** *(0001; rebuilt in 0002, 0005; +column in 0006)* — the `source` CHECK constraint grew over time
- Final shape: `id TEXT PRIMARY KEY`, `user_id → users.id ON DELETE CASCADE`, `source TEXT CHECK IN ('plaid','teller','csv','manual','amazon')`, `account_id TEXT → accounts.id`, `status TEXT DEFAULT 'pending' CHECK IN ('pending','running','completed','failed')`, `date_from TEXT`, `date_to TEXT`, `transactions_found INTEGER DEFAULT 0`, `transactions_imported INTEGER DEFAULT 0`, `error_message TEXT`, `created_at`, `completed_at TEXT`, `tax_year INTEGER`
- `INDEX idx_imports_user_tax_year(user_id, tax_year, created_at DESC)`
- 0012 dropped the tax-year workflow tables but explicitly left `imports.tax_year` in place because SQLite can't drop columns; new rows are NULL.

**`transactions`** *(0001; +column in 0002, +column in 0019)*
- `id TEXT PRIMARY KEY`, `user_id → users.id ON DELETE CASCADE`, `account_id TEXT → accounts.id`, `import_id TEXT → imports.id`, `plaid_transaction_id TEXT UNIQUE`, `posted_date TEXT NOT NULL`, `amount REAL NOT NULL`, `currency TEXT NOT NULL DEFAULT 'USD'`, `merchant_name TEXT`, `description TEXT NOT NULL`, `description_clean TEXT`, `category_plaid TEXT`, `is_pending INTEGER DEFAULT 0`, `dedup_hash TEXT UNIQUE`, `created_at`, `teller_transaction_id TEXT`, `note TEXT`
- `INDEX idx_transactions_user_date(user_id, posted_date)`
- `INDEX idx_transactions_account(account_id)`
- `INDEX idx_transactions_dedup(dedup_hash)`
- `UNIQUE INDEX idx_transactions_teller_transaction_id WHERE teller_transaction_id IS NOT NULL`

#### Classification

**`classifications`** *(0001; rebuilt in 0008 to widen entity CHECK; +column 0014, 0015)*
- Final: `id TEXT PRIMARY KEY`, `transaction_id TEXT NOT NULL UNIQUE → transactions.id ON DELETE CASCADE`, `business_entity_id → business_entities.id`, `chart_of_account_id → chart_of_accounts.id`, `entity TEXT CHECK IN ('elyse_coaching','jeremy_coaching','airbnb_activity','family_personal')`, `category_tax TEXT`, `category_budget TEXT`, `confidence REAL`, `method TEXT CHECK IN ('rule','ai','manual','historical')`, `reason_codes TEXT`, `review_required INTEGER DEFAULT 0`, `is_locked INTEGER DEFAULT 0`, `classified_at`, `classified_by TEXT DEFAULT 'system'`, `expense_type TEXT CHECK IN (NULL,'recurring','one_time')`, `cut_status TEXT CHECK IN (NULL,'flagged','complete')`
- `INDEX idx_classifications_entity(entity)`, `INDEX idx_classifications_review(review_required)`, `INDEX idx_classifications_cut_status(cut_status) WHERE cut_status IS NOT NULL`

**`classification_history`** *(0001; +columns 0014, 0015)*
- `id TEXT PRIMARY KEY`, `transaction_id → transactions.id ON DELETE CASCADE`, `entity TEXT`, `category_tax TEXT`, `category_budget TEXT`, `confidence REAL`, `method TEXT`, `reason_codes TEXT`, `changed_by TEXT DEFAULT 'system'`, `changed_at`, `expense_type TEXT`, `cut_status TEXT`
- `INDEX idx_classification_history_tx(transaction_id)`
- No CHECK constraints on entity/method here — bare TEXT, so 0008 only had to `UPDATE` the data.

**`transaction_splits`** *(0001; rebuilt in 0008)*
- `id TEXT PRIMARY KEY`, `transaction_id → transactions.id ON DELETE CASCADE`, `business_entity_id`, `chart_of_account_id`, `entity TEXT NOT NULL CHECK IN ('elyse_coaching','jeremy_coaching','airbnb_activity','family_personal')`, `category_tax TEXT`, `amount REAL NOT NULL`, `note TEXT`, `created_at`

**`rules`** *(0001; rebuilt in 0008)* — deterministic classification rules
- `id TEXT PRIMARY KEY`, `user_id → users.id ON DELETE CASCADE`, `name TEXT NOT NULL`, `match_field CHECK IN ('merchant_name','description','account_id','amount')`, `match_operator CHECK IN ('contains','equals','starts_with','ends_with','regex')`, `match_value TEXT NOT NULL`, `entity CHECK IN ('elyse_coaching','jeremy_coaching','airbnb_activity','family_personal')`, `category_tax`, `category_budget`, `priority INTEGER DEFAULT 0`, `is_active INTEGER DEFAULT 1`, `created_at`
- `INDEX idx_rules_priority(user_id, is_active, priority DESC)`

**`review_queue`** *(0001; rebuilt in 0003 to add 'unclassified' reason; +columns 0004)*
- `id TEXT PRIMARY KEY`, `transaction_id TEXT NOT NULL UNIQUE → transactions.id ON DELETE CASCADE`, `user_id → users.id ON DELETE CASCADE`, `reason CHECK IN ('low_confidence','no_match','conflict','flagged','unclassified')`, `suggested_entity TEXT`, `suggested_category_tax TEXT`, `confidence REAL`, `status TEXT DEFAULT 'pending' CHECK IN ('pending','resolved','skipped')`, `resolved_at`, `resolved_by`, `created_at`, `details TEXT`, `needs_input TEXT`
- `INDEX idx_review_queue_status(user_id, status)`

#### Budget / income

**`budget_categories`** *(0007)*
- `id`, `user_id → users.id ON DELETE CASCADE`, `slug`, `name`, `parent_slug TEXT`, `is_active INTEGER DEFAULT 1`, `created_at`; `UNIQUE(user_id, slug)`; `INDEX idx_budget_categories_user(user_id)`
- Note from migration: `budget_categories.slug` mirrors `classifications.category_budget` but there is no FK because classifications pre-date this feature.

**`budget_targets`** *(0007; rebuilt in 0014 to add 'one_time')*
- `id`, `user_id → users.id ON DELETE CASCADE`, `category_slug TEXT`, `cadence CHECK IN ('weekly','monthly','annual','one_time')`, `amount REAL`, `effective_from TEXT DEFAULT (date('now'))`, `effective_to TEXT`, `notes TEXT`, `created_at`
- `INDEX idx_budget_targets_user_cat(user_id, category_slug)`, `INDEX idx_budget_targets_effective(user_id, effective_from, effective_to)`

**`income_targets`** *(0013)*
- `id`, `user_id`, `entity CHECK IN ('elyse_coaching','jeremy_coaching','airbnb_activity','family_personal')`, `cadence CHECK IN ('weekly','monthly','annual')`, `amount REAL CHECK ≥0`, `effective_from`, `effective_to`, `notes`, `created_at`
- `INDEX income_targets_user_entity(user_id, entity)`

#### Attachments / snapshots

**`attachments`** *(0001)* — receipts in R2
- `id`, `transaction_id → transactions.id ON DELETE SET NULL`, `user_id → users.id ON DELETE CASCADE`, `r2_key TEXT UNIQUE`, `filename`, `content_type`, `size_bytes`, `note`, `created_at`

**`filing_snapshots`** *(0001)* — immutable filing exports
- `id`, `user_id → users.id ON DELETE CASCADE`, `tax_year INTEGER`, `name TEXT`, `r2_key TEXT`, `created_at`

#### Amazon CSV / email enrichment

**`amazon_orders`** *(0005)*
- `id`, `user_id → users.id ON DELETE CASCADE`, `import_id → imports.id ON DELETE CASCADE`, `order_key TEXT NOT NULL`, `order_id TEXT`, `order_date TEXT`, `shipment_date TEXT`, `total_amount REAL`, `quantity_total INTEGER DEFAULT 1`, `product_names TEXT NOT NULL`, `seller_names TEXT`, `order_status TEXT`, `payment_instrument_type TEXT`, `ship_to TEXT`, `shipping_address TEXT`, `created_at`
- `INDEX idx_amazon_orders_user_dates(user_id, order_date, shipment_date)`, `INDEX idx_amazon_orders_import(import_id)`

**`amazon_transaction_matches`** *(0005)*
- `id`, `user_id`, `amazon_order_id TEXT UNIQUE → amazon_orders.id ON DELETE CASCADE`, `transaction_id TEXT UNIQUE → transactions.id ON DELETE CASCADE`, `match_score REAL`, `match_method TEXT`, `created_at`
- `INDEX idx_amazon_matches_tx(transaction_id)`

**`amazon_email_processed`** *(0015_gmail_enrollments)* — Gmail dedup
- `id`, `user_id`, `gmail_message_id TEXT UNIQUE NOT NULL`, `order_id`, `processed_at`
- `INDEX idx_amazon_email_processed_user(user_id)`

#### Venmo / Apple / Etsy email enrichment

**`email_sync_state`** *(0016, +columns 0017_apple, 0018_etsy)*
- `user_id TEXT PRIMARY KEY`, `amazon_last_synced_at`, `venmo_last_synced_at`, `apple_last_synced_at`, `etsy_last_synced_at`

**`venmo_email_matches`** *(0016)*
- `id`, `user_id`, `transaction_id TEXT UNIQUE → transactions.id ON DELETE CASCADE`, `counterparty`, `memo`, `direction CHECK IN ('received','sent','charged')`, `venmo_amount REAL`, `venmo_date TEXT`, `gmail_message_id`, `created_at`
- `INDEX idx_venmo_matches_tx(transaction_id)`

**`venmo_email_processed`** *(0016)*
- `id`, `user_id`, `gmail_message_id TEXT UNIQUE NOT NULL`, `processed_at`
- `INDEX idx_venmo_email_processed_msg(gmail_message_id)`

**`apple_email_matches`** *(0017_apple_email_sync)*
- `id`, `user_id`, `transaction_id TEXT UNIQUE → transactions.id ON DELETE CASCADE`, `receipt_id`, `items_json TEXT NOT NULL DEFAULT '[]'`, `total_amount REAL NOT NULL`, `receipt_date`, `gmail_message_id`, `created_at`
- `INDEX idx_apple_matches_tx(transaction_id)`

**`apple_email_processed`** *(0017_apple)*
- `id`, `user_id`, `gmail_message_id TEXT UNIQUE NOT NULL`, `receipt_id`, `processed_at`
- `INDEX idx_apple_email_processed_msg(gmail_message_id)`

**`etsy_email_matches`** *(0018)*
- `id`, `user_id`, `transaction_id TEXT UNIQUE → transactions.id ON DELETE CASCADE`, `order_id`, `items_json TEXT NOT NULL DEFAULT '[]'`, `shop_name`, `total_amount REAL`, `receipt_date`, `gmail_message_id`, `created_at`
- `INDEX idx_etsy_matches_tx(transaction_id)`

**`etsy_email_processed`** *(0018)*
- `id`, `user_id`, `gmail_message_id TEXT UNIQUE NOT NULL`, `order_id`, `processed_at`
- `INDEX idx_etsy_email_processed_msg(gmail_message_id)`

#### SMS gamification (Phase A + B)

**`sms_persons`** *(0010)* — PRIMARY KEY `(user_id, person)` where `person CHECK IN ('jeremy','elyse')`
- Columns: `phone_e164`, `timezone DEFAULT 'America/Los_Angeles'`, `preferred_send_slots TEXT` (default JSON `[{"hour":8,...}]`), `preferred_batch_size INTEGER DEFAULT 1`, `opted_in_at`, `paused_until_date TEXT`, `created_at`, `updated_at`
- `UNIQUE INDEX idx_sms_persons_phone(phone_e164)`

**`sms_sessions`** *(0010; +batch_json 0011)*
- `id PK`, `user_id`, `person`, `transaction_id → transactions.id ON DELETE CASCADE`, `suggested_entity/_category_tax/_category_budget/_confidence/_method`, `status CHECK IN ('awaiting_reply','confirmed','rerouted','paused','unsubscribed','timed_out')`, `variant_id`, `sent_at`, `responded_at`, `closed_at`, `batch_json TEXT`
- `INDEX idx_sms_sessions_open(user_id, person, status)`, `INDEX idx_sms_sessions_tx(transaction_id)`

**`sms_messages`** *(0010)*
- `id PK`, `session_id → sms_sessions.id ON DELETE CASCADE`, `user_id`, `person`, `direction CHECK IN ('outbound','inbound')`, `body`, `twilio_sid`, `twilio_payload`, `created_at`
- `UNIQUE INDEX idx_sms_messages_sid WHERE twilio_sid IS NOT NULL`

**`sms_outcomes`** *(0010)*
- `id PK`, `session_id → sms_sessions.id ON DELETE CASCADE`, `transaction_id`, `user_id`, `person`, `action CHECK IN ('confirmed','rerouted','free_text','timed_out')`, `category_tax`, `category_budget`, `entity`, `source CHECK IN ('preset','free_text')`, `confidence`, `latency_seconds`, `created_at`
- `INDEX idx_sms_outcomes_person(user_id, person, created_at DESC)`

**`sms_routing_overrides`** *(0010)*
- `transaction_id PK → transactions.id ON DELETE CASCADE`, `user_id`, `target_person CHECK IN ('jeremy','elyse')`, `source_person CHECK IN ('jeremy','elyse')`, `created_at`
- `INDEX idx_sms_routing_target(user_id, target_person)`

#### Web auth

**`WebSessions`** *(0009)* — populated by `@agentbuilder/web-ui-kit`
- `_row_id INTEGER PK AUTOINCREMENT`, `sessionId TEXT`, `createdAt TEXT`, `expiresAt TEXT`
- `UNIQUE INDEX idx_websessions_sessionId(sessionId)`, `INDEX idx_websessions_expiresAt(expiresAt)`

#### Dropped tables

`tax_year_workflows`, `tax_year_checklist_items` (created 0006, dropped 0012), `gmail_enrollments` (created 0015_gmail_enrollments, dropped 0016 in favour of fleet OAuth env vars).

### 1b. Foreign-key summary

Most parent→child relationships are declared as REFERENCES with explicit ON DELETE behaviour:

- `users` is the root; `business_entities`, `accounts`, `plaid_items`, `teller_enrollments`, `imports`, `transactions`, `classifications`, `rules`, `review_queue`, `attachments`, `filing_snapshots`, `budget_categories`, `budget_targets`, `amazon_orders`, `gmail_enrollments` (dropped), `sms_sessions` (via `transaction_id` cascade only), all cascade on user delete (`ON DELETE CASCADE`).
- `transactions → accounts.id` and `transactions → imports.id` have no ON DELETE clause (default RESTRICT/NO ACTION in SQLite).
- `classifications`, `transaction_splits`, `review_queue`, `attachments`, `amazon_transaction_matches`, `venmo_email_matches`, `apple_email_matches`, `etsy_email_matches`, `sms_sessions`, `sms_routing_overrides` all reference `transactions.id ON DELETE CASCADE`.
- The Phase A/B SMS tables `sms_messages`, `sms_outcomes` reference `sms_sessions.id ON DELETE CASCADE`; their `user_id`/`person` columns reference no parent.
- `tax_categories`, `income_targets`, `email_sync_state`, `*_email_processed` tables hold `user_id` as plain TEXT with no FK.

### 1c. Tables grouped by question's domain hints

- **Transactions:** `transactions` (+ `transaction_splits` for one-tx-many-categories).
- **Account info:** `accounts`, `teller_enrollments`, `plaid_items`.
- **Categories:** `chart_of_accounts` (per-entity, seeded from `src/types.ts` constants), `tax_categories` (alternate, user-editable, per-user), `budget_categories` (family budget side), plus three hard-coded category dictionaries in `src/types.ts` (`SCHEDULE_C_CATEGORIES`, `AIRBNB_CATEGORIES`, `FAMILY_CATEGORIES`).
- **Entities:** `business_entities` (four entities seeded: `elyse_coaching`, `jeremy_coaching`, `airbnb` (= Whitford House), `family`). Note the slug mismatch between the seed table (`airbnb`, `family`) and the CHECK-constrained `classifications.entity` enum (`airbnb_activity`, `family_personal`).
- **Rules:** `rules` (deterministic) plus `sms_outcomes`/`venmo_email_matches`/`amazon_transaction_matches` as data sources for learning (`src/lib/learned-rules.ts`).
- **Budget amounts:** `budget_targets` (cadenced) and `income_targets` (cadenced).
- **Knowledge / notes files:** **not in D1.** Bookkeeping notes live in R2 (`BUCKET` binding) at key prefix `bookkeeping-notes/<userId>/<entity>.md` (text/markdown). See `src/lib/bookkeeping-notes.ts`.

### 1d. Row counts

The repository does **not** contain a populated production data dump. The only `.sql` file with INSERT statements is `apps/cfo/pre-migration-backup.sql`, which contains a schema snapshot + 8 INSERT rows total — all into SQLite metadata tables (`d1_migrations`, `sqlite_sequence`), zero domain data rows. No seed fixtures or test data files exist anywhere under `apps/cfo/`.

Concrete domain row counts therefore cannot be determined from the repo; they live only in the production `cfo-db` D1 database. Indirect signals in the code:

- The Claude system prompt in `apps/cfo/src/lib/claude.ts` (lines ~470–492) names specific recurring merchants with transaction counts ("GONG IO INC … 46 txns", "EMILY LEE … 26 txns", "POLARIS INSIGHT … 29 txns", "KATSAM … 27 txns", "OCEAN AVENEUE … 13 txns", "PATELCO … 28 txns", "SUMUP … 6 txns"). This is the only quantitative footprint visible in source.

---

## 2. Teller Integration

### 2a. Files

- **Client:** `apps/cfo/src/lib/teller.ts` (175 lines).
- **Sync / enrollment orchestration:** `apps/cfo/src/routes/teller.ts` (439 lines).
- **HTTP surface dispatching to Teller (and Plaid):** `apps/cfo/src/routes/bank.ts` (202 lines).
- **Cron driver:** `apps/cfo/src/lib/nightly-sync.ts` (115 lines), wired to the `0 9 * * *` cron in `src/index.ts:472-489`.
- **mTLS binding:** `[[mtls_certificates]] binding = "TELLER_MTLS"` in `apps/cfo/wrangler.toml`, certificate id `1c40bf07-6ba7-4e8c-b95f-27df8e7adfda`. Required for non-sandbox environments per `requiresMtls()` in `src/lib/teller.ts:64`.

### 2b. Teller API endpoints called

All against `https://api.teller.io`, HTTP Basic auth with `<access_token>:` (empty password):

| Endpoint | Function | Purpose |
|---|---|---|
| `GET /accounts` | `listAccounts(env, accessToken)` (`teller.ts:139`) | List accounts for an enrollment after the client completes Teller Connect. Returns id, name, type, subtype, last_four, status, institution, and HATEOAS links. |
| `GET /accounts/{account_id}/transactions?count=500&start_date=&end_date=&from_id=` | `listTransactions(env, accessToken, accountId, opts)` (`teller.ts:143`) | Paginated transaction list. Iterates with `from_id = page[last].id` until a partial page is returned. |

No other Teller endpoints (balances, identity, payments, webhooks) are called. No write endpoints are used.

### 2c. Teller authentication

- **Application ID** comes from `env.TELLER_APPLICATION_ID` and is returned to the SPA at `GET /bank/config` so the browser-side Teller Connect can mount with `application_id`, `environment`, `products: ['transactions']`, `select_account: 'multiple'`. See `getTellerConnectConfig` in `src/lib/teller.ts:121-137`.
- **Access tokens** are obtained client-side by Teller Connect, then posted to `POST /bank/connect/complete` along with the enrollment id (`src/routes/bank.ts:115-169`). The server stores them in `teller_enrollments.access_token` as **plaintext** D1 column data — no encryption, no `@agentbuilder/credential-vault` use.
- **No refresh flow.** Teller access tokens are long-lived; the only "refresh" handled is when an institution requires re-MFA: if `listTransactions` raises an error containing `enrollment.disconnected`, `syncTellerTransactionsForUser` throws back to the caller with an instruction to re-link via the bank connection flow (`src/routes/teller.ts:405-413, 424-430`).
- **Transport:** all non-sandbox calls go through `env.TELLER_MTLS.fetch(...)`. The mTLS cert binding is managed in `wrangler.toml`. Sandbox bypasses mTLS and uses plain `fetch`.

### 2d. Fields stored

Per `syncAccountTransactions` (`src/routes/teller.ts:34-163`), each Teller transaction maps to a row in `transactions` with:

- `posted_date` ← `tx.date`
- `amount` ← `Number(tx.amount)` (Teller returns string; negative = debit/expense from bank perspective)
- `currency` ← hardcoded `'USD'`
- `merchant_name` ← `tx.details?.counterparty?.name ?? null`
- `description` ← `tx.description` (raw)
- `description_clean` ← `cleanDescription(tx.description)` (lowercased, alnum + a few punctuation)
- `category_plaid` ← `tx.details?.category ?? null` (column reused for Teller's category — name is a historical artifact)
- `is_pending` ← `tx.status === 'pending' ? 1 : 0`
- `teller_transaction_id` ← `tx.id`
- `dedup_hash` ← `SHA-256(accountId | postedDate | amount.toFixed(2) | description.toLowerCase().trim())` via `src/lib/dedup.ts`
- `account_id`, `import_id`, `user_id` ← sync context

Accounts (`accounts` table) get `teller_account_id`, `teller_enrollment_id`, `name`, `mask` (last_four), `type`, `subtype`. Enrollments (`teller_enrollments`) get `access_token`, `enrollment_id`, `institution_id`, `institution_name`, `last_synced_at`.

### 2e. Sync triggers

1. **Cron** — `0 9 * * *` (Cloudflare runs in UTC; comment says ~05:00 ET). `scheduled()` in `src/index.ts` dispatches to `runCron(env, { agentId: 'cfo', trigger: 'nightly-sync', ... }, () => runNightlyTellerSync(env))`. The handler unions all distinct `user_id`s from `teller_enrollments` and `plaid_items`, then calls `syncTellerTransactionsForUser` per user with `dateFrom=null, dateTo=null` (full window).
2. **Manual REST** — `POST /bank/sync` (in `apps/cfo/src/index.ts:167`, handler in `apps/cfo/src/routes/bank.ts:172-202`). Body may include `provider` and `account_ids` to scope a sync.
3. **Manual debug** — `POST /cron/nightly-sync` short-circuits straight to `runNightlyTellerSync(env)` for re-running on demand (`src/index.ts:254`).
4. **MCP tool** — `teller_sync` (registered in `apps/cfo/src/mcp-tools.ts:63`) synthesizes the same `POST /bank/sync` request.
5. **No webhook.** Teller does not push; the integration is pull-only.

### 2f. Connected account types

Determined at runtime by the institutions the user links via Teller Connect — not statically defined in code. The sync filters to `account.status === 'open' && account.links.transactions` (`src/routes/teller.ts:222`), so any open transaction-capable account is accepted. The PLAID side enumerates two fixed institutions (Patelco, EastRise) in `src/lib/plaid.ts:24`. The Claude system prompt mentions Gong (Jeremy's W-2 employer payroll deposits), Patelco (in the rules-out comment, suggesting a loan), Venmo, and Northwestern Mutual — but those are illustrative training context for the classifier, not declared account types.

### 2g. Modularity assessment

The Teller integration spans two layers:

- `src/lib/teller.ts` is **dependency-free toward the CFO domain.** It only imports `Env` and exports `TellerAccount`, `TellerTransaction`, `TellerEnrollmentPayload`, `getTellerConnectConfig`, `listAccounts`, `listTransactions`. The mTLS-vs-plain `fetch` selection reads `env.TELLER_ENV` and `env.TELLER_MTLS`. **Extractable** to a shared package with minimal change (replace `Env` with a minimal interface holding `TELLER_APPLICATION_ID`, `TELLER_ENV`, `TELLER_MTLS`).
- `src/routes/teller.ts` is **tightly coupled** to CFO data shapes. `syncAccountTransactions` writes directly into the `transactions`, `imports`, and `review_queue` tables; `connectTellerEnrollmentForUser` writes to `teller_enrollments` and `accounts`. The dedup hash, pending→posted promotion logic, and seed of an `'unclassified'` review-queue row on every newly posted insert are all CFO-specific.

### 2h. Verbatim source

#### `apps/cfo/src/lib/teller.ts`

```ts
import type { Env } from '../types';

const TELLER_API_BASE = 'https://api.teller.io';
const DEFAULT_PAGE_SIZE = 500;

export interface TellerEnrollmentPayload {
  access_token: string;
  enrollment_id: string;
  institution_name?: string | null;
  institution_id?: string | null;
}

export interface TellerAccount {
  enrollment_id: string;
  id: string;
  name: string;
  type: string;
  subtype: string | null;
  currency: string;
  last_four: string | null;
  status: 'open' | 'closed';
  institution: {
    id: string;
    name: string;
  };
  links: {
    self?: string;
    balances?: string;
    transactions?: string;
    details?: string;
  };
}

export interface TellerTransaction {
  id: string;
  account_id: string;
  date: string;
  amount: string;
  description: string;
  status: 'posted' | 'pending';
  type: string;
  running_balance: string | null;
  details?: {
    category?: string | null;
    processing_status?: 'pending' | 'complete';
    counterparty?: {
      name?: string | null;
      type?: string | null;
    };
  };
}

interface TellerApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

function getTellerEnvironment(env: Env): string {
  return env.TELLER_ENV ?? 'sandbox';
}

function requiresMtls(env: Env): boolean {
  return getTellerEnvironment(env) !== 'sandbox';
}

async function tellerRequest<T>(
  env: Env,
  accessToken: string,
  path: string,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const url = new URL(`${TELLER_API_BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const res = requiresMtls(env)
    ? await (() => {
        if (!env.TELLER_MTLS) {
          throw new Error('Teller development/production requires a TELLER_MTLS binding in wrangler.toml.');
        }

        return env.TELLER_MTLS.fetch(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Basic ${btoa(`${accessToken}:`)}`,
          },
        });
      })()
    : await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${btoa(`${accessToken}:`)}`,
    },
  });

  const raw = await res.text();
  let data: T | TellerApiErrorResponse | null = null;
  if (raw) {
    try {
      data = JSON.parse(raw) as T | TellerApiErrorResponse;
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const error = data as TellerApiErrorResponse | null;
    const code = error?.error?.code ?? String(res.status);
    const message = error?.error?.message ?? (raw || res.statusText);
    throw new Error(`Teller ${path} failed: ${code} - ${message}`);
  }

  return data as T;
}

export function getTellerConnectConfig(env: Env): {
  application_id: string;
  environment: string;
  products: string[];
  select_account: 'multiple';
} {
  if (!env.TELLER_APPLICATION_ID) {
    throw new Error('TELLER_APPLICATION_ID is not configured.');
  }

  return {
    application_id: env.TELLER_APPLICATION_ID,
    environment: getTellerEnvironment(env),
    products: ['transactions'],
    select_account: 'multiple',
  };
}

export async function listAccounts(env: Env, accessToken: string): Promise<TellerAccount[]> {
  return tellerRequest<TellerAccount[]>(env, accessToken, '/accounts');
}

export async function listTransactions(
  env: Env,
  accessToken: string,
  accountId: string,
  opts: { startDate?: string; endDate?: string; count?: number } = {},
): Promise<TellerTransaction[]> {
  const count = opts.count ?? DEFAULT_PAGE_SIZE;
  const transactions: TellerTransaction[] = [];
  let fromId: string | undefined;

  while (true) {
    const page = await tellerRequest<TellerTransaction[]>(
      env,
      accessToken,
      `/accounts/${accountId}/transactions`,
      {
        count: String(count),
        start_date: opts.startDate,
        end_date: opts.endDate,
        from_id: fromId,
      },
    );

    transactions.push(...page);
    if (page.length < count) break;

    const nextFromId = page[page.length - 1]?.id;
    if (!nextFromId || nextFromId === fromId) break;
    fromId = nextFromId;
  }

  return transactions;
}
```

#### `apps/cfo/src/routes/teller.ts`

The full sync/enroll module (440 lines). Inlined here for reference — original behaviour preserved.

```ts
import type { Env } from '../types';
import { cleanDescription, computeDedupHash } from '../lib/dedup';
import {
  getTellerConnectConfig,
  listAccounts,
  listTransactions,
  type TellerEnrollmentPayload,
  type TellerTransaction,
} from '../lib/teller';

interface TellerSyncSummary {
  transactions_imported: number;
  duplicates_skipped: number;
  by_institution: Array<{ institution: string | null; added: number; dupes: number }>;
  account_ids_synced: string[];
  message: string;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDate(base: string, days: number): string {
  const date = new Date(`${base}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function todayIsoDate(): string {
  return isoDate(new Date());
}

async function syncAccountTransactions(
  env: Env,
  userId: string,
  accountId: string,
  providerAccountId: string,
  importId: string,
  transactions: TellerTransaction[],
): Promise<{ added: number; dupes: number }> {
  if (transactions.length === 0) return { added: 0, dupes: 0 };

  // Pre-fetch all existing teller tx IDs for this account (1 query instead of N)
  const existingRows = await env.DB.prepare(
    `SELECT id, teller_transaction_id FROM transactions
     WHERE account_id = ? AND teller_transaction_id IS NOT NULL`,
  ).bind(accountId).all<{ id: string; teller_transaction_id: string }>();
  const existingMap = new Map(existingRows.results.map(r => [r.teller_transaction_id, r.id]));

  // Pre-fetch all pending transactions for this account (1 query instead of N)
  const pendingRows = await env.DB.prepare(
    `SELECT id, amount, description_clean, posted_date FROM transactions
     WHERE account_id = ? AND is_pending = 1 AND teller_transaction_id IS NOT NULL`,
  ).bind(accountId).all<{ id: string; amount: number; description_clean: string; posted_date: string }>();
  const pendingList = [...pendingRows.results];

  // Compute all dedup hashes in parallel
  const amounts = transactions.map(tx => {
    const n = Number(tx.amount);
    if (Number.isNaN(n)) throw new Error(`Bad amount "${tx.amount}" for ${tx.id}`);
    return n;
  });
  const hashes = await Promise.all(
    transactions.map((tx, i) => computeDedupHash(providerAccountId, tx.date, amounts[i], tx.description)),
  );

  const BATCH = 100;
  const updateStatements: D1PreparedStatement[] = [];
  const insertStatements: D1PreparedStatement[] = [];
  const insertMeta: Array<{ txId: string; isPosted: boolean }> = [];

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const amount = amounts[i];
    const dedupHash = hashes[i];
    const descClean = cleanDescription(tx.description);
    const merchant = tx.details?.counterparty?.name ?? null;
    const category = tx.details?.category ?? null;
    const isPending = tx.status === 'pending' ? 1 : 0;

    const existingId = existingMap.get(tx.id);
    if (existingId) {
      updateStatements.push(env.DB.prepare(
        `UPDATE transactions
         SET account_id=?, import_id=?, posted_date=?, amount=?, currency='USD',
             merchant_name=?, description=?, description_clean=?, category_plaid=?,
             is_pending=?, dedup_hash=?
         WHERE id=?`,
      ).bind(accountId, importId, tx.date, amount, merchant, tx.description, descClean, category, isPending, dedupHash, existingId));
      continue;
    }

    // Pending → posted promotion (match in-memory)
    if (tx.status === 'posted') {
      const lo = shiftIsoDate(tx.date, -10);
      const hi = shiftIsoDate(tx.date, 10);
      const matchIdx = pendingList.findIndex(
        p => p.amount === amount && p.description_clean === descClean && p.posted_date >= lo && p.posted_date <= hi,
      );
      if (matchIdx !== -1) {
        const match = pendingList[matchIdx];
        pendingList.splice(matchIdx, 1);
        updateStatements.push(env.DB.prepare(
          `UPDATE transactions
           SET import_id=?, teller_transaction_id=?, posted_date=?, amount=?, currency='USD',
               merchant_name=?, description=?, description_clean=?, category_plaid=?,
               is_pending=0, dedup_hash=?
           WHERE id=?`,
        ).bind(importId, tx.id, tx.date, amount, merchant, tx.description, descClean, category, dedupHash, match.id));
        continue;
      }
    }

    // New transaction
    const txId = crypto.randomUUID();
    insertStatements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO transactions
         (id, user_id, account_id, import_id, teller_transaction_id,
          posted_date, amount, currency, merchant_name, description,
          description_clean, category_plaid, is_pending, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
    ).bind(txId, userId, accountId, importId, tx.id, tx.date, amount, merchant, tx.description, descClean, category, isPending, dedupHash));
    insertMeta.push({ txId, isPosted: tx.status === 'posted' });
  }

  // Batch updates (fire-and-forget result)
  for (let i = 0; i < updateStatements.length; i += BATCH) {
    await env.DB.batch(updateStatements.slice(i, i + BATCH));
  }

  // Batch inserts — check results to build review queue entries only for rows that landed
  let added = 0;
  let dupes = 0;
  const reviewStatements: D1PreparedStatement[] = [];
  for (let i = 0; i < insertStatements.length; i += BATCH) {
    const results = await env.DB.batch(insertStatements.slice(i, i + BATCH));
    for (let j = 0; j < results.length; j++) {
      const meta = insertMeta[i + j];
      if (results[j].meta.changes > 0) {
        if (meta.isPosted) {
          added++;
          reviewStatements.push(env.DB.prepare(
            `INSERT OR IGNORE INTO review_queue
               (id, transaction_id, user_id, reason, confidence, details, needs_input)
             VALUES (?, ?, ?, 'unclassified', NULL,
               'No rule match or saved classification exists for this transaction yet.',
               'A clearer merchant name, notes, or a manual classification for a similar transaction would help future matches.')`,
          ).bind(crypto.randomUUID(), meta.txId, userId));
        }
      } else {
        dupes++;
      }
    }
  }

  // Batch review queue inserts
  for (let i = 0; i < reviewStatements.length; i += BATCH) {
    await env.DB.batch(reviewStatements.slice(i, i + BATCH));
  }

  return { added, dupes };
}

async function removeMissingPendingTransactions(
  env: Env,
  accountId: string,
  startDate: string | null,
  endDate: string,
  seenTransactionIds: Set<string>,
): Promise<void> {
  const existingPending = startDate
    ? await env.DB.prepare(
        `SELECT id, teller_transaction_id
         FROM transactions
         WHERE account_id = ?
           AND teller_transaction_id IS NOT NULL
           AND is_pending = 1
           AND posted_date BETWEEN ? AND ?`,
      ).bind(accountId, startDate, endDate).all<{ id: string; teller_transaction_id: string | null }>()
    : await env.DB.prepare(
        `SELECT id, teller_transaction_id
         FROM transactions
         WHERE account_id = ?
           AND teller_transaction_id IS NOT NULL
           AND is_pending = 1`,
      ).bind(accountId).all<{ id: string; teller_transaction_id: string | null }>();

  const toDelete = existingPending.results.filter(
    r => r.teller_transaction_id && !seenTransactionIds.has(r.teller_transaction_id),
  );
  if (toDelete.length === 0) return;

  const BATCH = 100;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    await env.DB.batch(
      toDelete.slice(i, i + BATCH).map(r => env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(r.id)),
    );
  }
}

export function getTellerBankConfig(env: Env): {
  provider: 'teller';
  application_id: string;
  environment: string;
  products: string[];
  select_account: 'multiple';
} {
  const config = getTellerConnectConfig(env);
  return {
    provider: 'teller',
    ...config,
  };
}

export async function connectTellerEnrollmentForUser(
  env: Env,
  userId: string,
  payload: TellerEnrollmentPayload,
): Promise<{ enrollment_id: string; institution: string | null; accounts_linked: number; message: string }> {
  const accounts = await listAccounts(env, payload.access_token);
  const supportedAccounts = accounts.filter((account) => account.status === 'open' && Boolean(account.links.transactions));
  if (!supportedAccounts.length) {
    throw new Error('Teller enrollment completed, but no transaction-capable accounts were returned.');
  }

  const tellerEnrollmentId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO teller_enrollments (id, user_id, enrollment_id, access_token, institution_id, institution_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(enrollment_id) DO UPDATE SET
       access_token=excluded.access_token,
       institution_id=COALESCE(excluded.institution_id, teller_enrollments.institution_id),
       institution_name=COALESCE(excluded.institution_name, teller_enrollments.institution_name)`,
  ).bind(
    tellerEnrollmentId,
    userId,
    payload.enrollment_id,
    payload.access_token,
    payload.institution_id ?? null,
    payload.institution_name ?? null,
  ).run();

  const enrollment = await env.DB.prepare(
    'SELECT id FROM teller_enrollments WHERE enrollment_id = ?',
  ).bind(payload.enrollment_id).first<{ id: string }>();
  if (!enrollment) throw new Error('Failed to save Teller enrollment');

  const institutionName = payload.institution_name
    ?? supportedAccounts[0]?.institution.name
    ?? null;
  const institutionId = payload.institution_id
    ?? supportedAccounts[0]?.institution.id
    ?? null;

  await env.DB.prepare(
    `UPDATE teller_enrollments
     SET institution_id = COALESCE(?, institution_id),
         institution_name = COALESCE(?, institution_name)
     WHERE id = ?`,
  ).bind(institutionId, institutionName, enrollment.id).run();

  for (const account of supportedAccounts) {
    const existingAccount = await env.DB.prepare(
      'SELECT id FROM accounts WHERE teller_account_id = ?',
    ).bind(account.id).first<{ id: string }>()
    ?? await env.DB.prepare(
      `SELECT id FROM accounts
       WHERE user_id = ? AND name = ? AND mask = ? AND type = ? AND subtype = ?
       LIMIT 1`,
    ).bind(userId, account.name, account.last_four ?? null, account.type, account.subtype ?? null)
     .first<{ id: string }>();

    if (existingAccount) {
      await env.DB.prepare(
        `UPDATE accounts
         SET teller_account_id=?,
             teller_enrollment_id=?,
             name=?,
             mask=?,
             type=?,
             subtype=?,
             is_active=1
         WHERE id=?`,
      ).bind(
        account.id,
        enrollment.id,
        account.name,
        account.last_four ?? null,
        account.type,
        account.subtype ?? null,
        existingAccount.id,
      ).run();
      continue;
    }

    const accountId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO accounts
         (id, teller_enrollment_id, user_id, teller_account_id, name, mask, type, subtype)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      accountId,
      enrollment.id,
      userId,
      account.id,
      account.name,
      account.last_four ?? null,
      account.type,
      account.subtype ?? null,
    ).run();
  }

  return {
    enrollment_id: payload.enrollment_id,
    institution: institutionName,
    accounts_linked: supportedAccounts.length,
    message: 'Accounts connected. Call POST /bank/sync to import transactions.',
  };
}

export async function syncTellerTransactionsForUser(
  env: Env,
  userId: string,
  dateFrom: string | null,
  dateTo: string | null,
  accountIds?: string[],
): Promise<TellerSyncSummary> {
  const enrollments = await env.DB.prepare(
    `SELECT id, access_token, institution_name, last_synced_at
     FROM teller_enrollments
     WHERE user_id = ?`,
  ).bind(userId).all<{ id: string; access_token: string; institution_name: string | null; last_synced_at: string | null }>();

  if (!enrollments.results.length) {
    throw new Error('No linked Teller accounts found. Connect an account first.');
  }

  const syncEnd = dateTo ?? todayIsoDate();
  let totalAdded = 0;
  let totalDupes = 0;
  const syncedAccountIds = new Set<string>();
  const byInstitution: Array<{ institution: string | null; added: number; dupes: number }> = [];
  const requestedAccountIds = new Set(accountIds ?? []);
  let matchedRequestedAccounts = 0;
  const reconnectRequired: string[] = [];

  for (const enrollment of enrollments.results) {
    const syncStart = dateFrom;
    const importId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO imports (id, user_id, source, status, date_from, date_to, tax_year)
       VALUES (?, ?, 'teller', 'running', ?, ?, ?)`,
    ).bind(importId, userId, syncStart ?? null, syncEnd, syncStart ? parseInt(syncStart.slice(0, 4), 10) : null).run();

    let added = 0;
    let dupes = 0;
    let found = 0;

    try {
      const accounts = await env.DB.prepare(
        `SELECT id, teller_account_id
         FROM accounts
         WHERE user_id = ?
           AND teller_enrollment_id = ?
           AND is_active = 1
           AND teller_account_id IS NOT NULL`,
      ).bind(userId, enrollment.id).all<{ id: string; teller_account_id: string }>();

      for (const account of accounts.results) {
        if (requestedAccountIds.size > 0 && !requestedAccountIds.has(account.id)) continue;
        matchedRequestedAccounts++;
        syncedAccountIds.add(account.id);
        const transactions = await listTransactions(
          env,
          enrollment.access_token,
          account.teller_account_id,
          { startDate: syncStart ?? undefined, endDate: syncEnd },
        );
        found += transactions.length;

        const seenTransactionIds = new Set(transactions.map(t => t.id));
        const result = await syncAccountTransactions(env, userId, account.id, account.teller_account_id, importId, transactions);
        added += result.added;
        dupes += result.dupes;

        await removeMissingPendingTransactions(
          env,
          account.id,
          syncStart,
          syncEnd,
          seenTransactionIds,
        );
      }

      await env.DB.prepare(
        `UPDATE teller_enrollments SET last_synced_at=datetime('now') WHERE id = ?`,
      ).bind(enrollment.id).run();

      await env.DB.prepare(
        `UPDATE imports
         SET status='completed', transactions_found=?, transactions_imported=?, completed_at=datetime('now')
         WHERE id=?`,
      ).bind(found, added, importId).run();
    } catch (err) {
      const errMsg = String(err);
      await env.DB.prepare(
        `UPDATE imports SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`,
      ).bind(errMsg, importId).run();
      if (errMsg.includes('enrollment.disconnected')) {
        reconnectRequired.push(enrollment.institution_name ?? 'Unknown institution');
      }
    }

    totalAdded += added;
    totalDupes += dupes;
    byInstitution.push({ institution: enrollment.institution_name, added, dupes });
  }

  if (requestedAccountIds.size > 0 && matchedRequestedAccounts === 0) {
    throw new Error('No linked Teller accounts matched the requested sync scope.');
  }

  if (reconnectRequired.length > 0) {
    const names = reconnectRequired.join(', ');
    throw new Error(
      `Bank re-enrollment required for: ${names}. MFA was requested by the institution but the ` +
      `enrollment is no longer active. Re-link via the bank connection flow to restore sync.`,
    );
  }

  return {
    transactions_imported: totalAdded,
    duplicates_skipped: totalDupes,
    by_institution: byInstitution,
    account_ids_synced: [...syncedAccountIds],
    message: 'Sync complete. New transactions are queued for review.',
  };
}
```

---

## 3. Email Parsing Integration

### 3a. Files

| File | Purpose | Lines |
|---|---|---|
| `apps/cfo/src/lib/gmail.ts` | Gmail REST client (OAuth refresh + search/get/decode) | 126 |
| `apps/cfo/src/lib/amazon-email.ts` | Parse Amazon order/shipment/delivery confirmation emails | 128 |
| `apps/cfo/src/lib/venmo-email.ts` | Parse Venmo payment notification emails | 101 |
| `apps/cfo/src/lib/apple-email.ts` | Parse `no_reply@email.apple.com` receipts | 163 |
| `apps/cfo/src/lib/etsy-email.ts` | Parse Etsy receipt/purchase emails (including forwarded) | 167 |
| `apps/cfo/src/lib/amazon.ts` | Amazon CSV + transaction-match logic (used by both CSV import and email pipeline) | 272 |
| `apps/cfo/src/lib/venmo.ts` | Venmo transaction-match + classification re-trigger | 122 |
| `apps/cfo/src/lib/apple.ts` | Apple receipt-match + classification re-trigger | 123 |
| `apps/cfo/src/lib/etsy.ts` | Etsy receipt-match + classification re-trigger | 117 |
| `apps/cfo/src/lib/nightly-email-sync.ts` | Orchestrator — runs all four pipelines under one cron | 348 |
| `apps/cfo/src/routes/gmail.ts` | `GET /gmail/status`, `POST /gmail/sync` REST handlers | 49 |

### 3b. Email sources handled

Four pipelines, each fetched from the user's personal Gmail via the Gmail v1 REST API:

1. **Amazon** — `from:(auto-confirm@amazon.com OR shipment-tracking@amazon.com) newer_than:Nd`.
   Three subject patterns recognised: `your amazon.com order of …`, `has shipped`, `delivered`. Stores `amazon_orders` rows and, on a fuzzy ±4/+12-day amount match, an `amazon_transaction_matches` row.
2. **Venmo** — `from:venmo@venmo.com newer_than:Nd`. Subject patterns:
   - `<Name> paid you $X.XX` (direction `received`)
   - `You paid <Name> $X.XX` (direction `sent`)
   - `<Name> charged you $X.XX` (direction `charged`)
   - `You charged <Name>` is intentionally skipped (no money moved yet).
3. **Apple** — `from:no_reply@email.apple.com subject:receipt newer_than:Nd`. Pulls grand total, optional receipt id (regex `\bM\d{9,}\b`), and a per-line-item list via two layered extractors (HTML `<tr>` rows then plain-text fallback). Stores items as JSON in `apple_email_matches.items_json`.
4. **Etsy** — searches by **subject only** (not `from:`) because Jeremy often forwards them — `subject:("etsy purchase" OR "you just bought" OR "order is confirmed" OR "receipt for your etsy") newer_than:Nd`. Order id from `#<digits>` or `(<digits>)`, shop from `from <Name>`, items via HTML table or text fallback. For forwarded emails (where `internalDate` is the forward timestamp) the parser tries to extract a body date and widens the match window to −60/+5 days.

### 3c. Email API

**Gmail REST v1** (`gmail.googleapis.com/gmail/v1/users/me/...`):

- `GET /messages?q=…&maxResults=…&pageToken=…` — search (paginated; up to `maxResults` per call). See `searchMessages` in `lib/gmail.ts:61`.
- `GET /messages/{id}?format=full` — fetch a single message. See `getMessage` in `lib/gmail.ts:86`.

No IMAP. No Pub/Sub. Pull-only.

### 3d. Authentication

- **Fleet-shared OAuth credentials** in env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`. Same secrets used by the `chief-of-staff` agent; obtained once via `chief-of-staff/scripts/google-auth.js` per the comment in `lib/gmail.ts:1-10`.
- Access token is exchanged on-demand via `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token` (`refreshAccessToken`, `lib/gmail.ts:34-48`).
- Migration 0015_gmail_enrollments originally stored a per-user refresh token in the `gmail_enrollments` D1 table; migration 0016 dropped that table and switched fully to the env-var path.
- The `@agentbuilder/auth-google` shared package exists in `packages/` but is **not** imported by the CFO. The OAuth refresh is implemented inline.

### 3e. Parsing strategy

All four pipelines are **regex- and DOM-walk-based**, not LLM-based:

- HTML emails are stripped (`stripHtml`) before regex extraction; rich HTML structures (`<tr>...<td>` for Apple/Etsy items, `/dp/` Amazon product detail links for products) get their own custom walker.
- Amounts: layered patterns — labeled (`Order Total`, `Total`, `Charged`) preferred, raw `$X.XX` fallback.
- Dates: epoch from `internalDate`; Etsy additionally parses month-name-day-year out of the body for forwarded-message robustness.
- Order ids: hardcoded format regexes (`\d{3}-\d{7}-\d{7}` for Amazon, `\bM\d{9,}\b` for Apple, `#(\d{9,})` for Etsy).
- The downstream **classifier** (the Claude pipeline in `lib/claude.ts`) does receive the extracted context (product names, Venmo memo, Apple/Etsy item lists) as additional input — see `loadAmazonContext`, `loadVenmoContext`, `loadAppleContext`, `loadEtsyContext`. So the LLM consumes parsed output but does not perform the email parsing itself.

### 3f. Reliability / error handling observable in code

- **Dedup tables** (`amazon_email_processed`, `venmo_email_processed`, `apple_email_processed`, `etsy_email_processed`) record every Gmail message id seen, so reruns skip already-processed messages. The dedup write happens **before** the parse result is checked, so messages that fail to parse are also marked processed and never retried — see e.g. `nightly-email-sync.ts:165-170, 238-243, 284-287, 331-334`. Comment in 0015 confirms this is intentional: "Prevents re-fetching and re-importing emails across nightly runs."
- **`email_sync_state.<vendor>_last_synced_at`** is written at the end of each run regardless of whether the pipeline raised — see `nightly-email-sync.ts:108-115` (single UPDATE for all four vendors after `Promise.all`).
- **Per-pipeline import row** is created only for Amazon (`source='amazon'`) and updated to `'failed'` with the error message if it throws (`nightly-email-sync.ts:198-206`). Venmo/Apple/Etsy do not create an `imports` row.
- **Match thresholds**:
  - Amazon: `score >= 60` required (`lib/amazon.ts:233`). Window ±4/+12 days; +25 if "amazon" appears in description; +25 max for date closeness.
  - Venmo: `score >= 60`; window ±2 days; +30 for "venmo" in description; +20 for exact date.
  - Apple: `score >= 50`; window −2/+5 days; +40 for "apple" in description; +10 for exact date.
  - Etsy: `score >= 50`; window ±5 (or −60/+5 for forwarded); +40 for "etsy" in description; +10 for exact date.
- **No retry logic.** Gmail API failures throw and bubble; Amazon catches and marks the import failed; Venmo/Apple/Etsy let the throw propagate to `runNightlyEmailSync`.
- **Skip flag.** If `env.GOOGLE_OAUTH_REFRESH_TOKEN` is not set, the whole nightly job logs and returns `{ skipped: true }` immediately (`nightly-email-sync.ts:79-82`).
- **No production reliability metric** is recorded in the repo. The `cron_runs` row written by `runCron` only captures success/failure of the whole nightly invocation, not per-pipeline match rate or parse-failure counts.

### 3g. Modularity assessment

- `src/lib/gmail.ts` is **dependency-free toward the CFO domain** (only imports `Env`). Reads three env vars. Extractable.
- The four `*-email.ts` parsers each export a pure `parseXxxEmail(message: GmailMessage)` function and depend only on the `GmailMessage` shape from `gmail.ts` (Apple/Etsy/Amazon also depend on the CFO context type for their return). Extractable individually if the return types are decoupled.
- The four matching modules (`amazon.ts`, `venmo.ts`, `apple.ts`, `etsy.ts`) are tightly coupled — they read/write CFO-specific tables (`*_email_matches`, `classifications`) and re-trigger `handleClassifySingle`. Not extractable without refactoring.
- The orchestrator `nightly-email-sync.ts` is CFO-specific (knows about `imports`, `email_sync_state`, the four pipelines as a fixed set).

### 3h. Verbatim source

#### `apps/cfo/src/lib/gmail.ts`

```ts
/**
 * Gmail REST API client for the CFO worker.
 *
 * Uses the fleet-wide Google OAuth credentials:
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
 *
 * These are the same secrets the chief-of-staff uses. The refresh token is
 * obtained once via scripts/google-auth.js in the chief-of-staff app and
 * stored as a Cloudflare secret — no in-app OAuth flow needed.
 */

import type { Env } from '../types';

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailMessagePart {
  mimeType: string;
  body: { data?: string; size: number };
  parts?: GmailMessagePart[];
  headers?: Array<{ name: string; value: string }>;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  payload: GmailMessagePart;
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<string> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`Gmail token refresh failed: ${await resp.text()}`);
  const data = await resp.json() as { access_token: string };
  return data.access_token;
}

export async function getEnvAccessToken(env: Env): Promise<string> {
  if (!env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error(
      'GOOGLE_OAUTH_REFRESH_TOKEN is not set. Run: wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN',
    );
  }
  return refreshAccessToken(env, env.GOOGLE_OAUTH_REFRESH_TOKEN);
}

export async function searchMessages(
  accessToken: string,
  query: string,
  maxResults = 200,
): Promise<GmailMessageRef[]> {
  const results: GmailMessageRef[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(Math.min(maxResults - results.length, 100)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) throw new Error(`Gmail search failed: ${await resp.text()}`);
    const data = await resp.json() as { messages?: GmailMessageRef[]; nextPageToken?: string };

    results.push(...(data.messages ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken && results.length < maxResults);

  return results;
}

export async function getMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) throw new Error(`Gmail getMessage failed: ${await resp.text()}`);
  return resp.json() as Promise<GmailMessage>;
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '=='.slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function extractPart(part: GmailMessagePart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body.data) return decodeBase64Url(part.body.data);
  if (part.parts) {
    for (const sub of part.parts) {
      const found = extractPart(sub, mimeType);
      if (found) return found;
    }
  }
  return null;
}

export function getMessageBody(message: GmailMessage): { text: string; html: string } {
  return {
    html: extractPart(message.payload, 'text/html') ?? '',
    text: extractPart(message.payload, 'text/plain') ?? '',
  };
}

export function getHeader(message: GmailMessage, name: string): string {
  return message.payload.headers
    ?.find(h => h.name.toLowerCase() === name.toLowerCase())
    ?.value ?? '';
}
```

#### `apps/cfo/src/lib/amazon-email.ts`

```ts
import type { GmailMessage } from './gmail';
import { getMessageBody, getHeader } from './gmail';

export interface AmazonEmailOrder {
  orderId: string;
  orderDate: string | null;
  shipmentDate: string | null;
  totalAmount: number | null;
  productNames: string[];
  sellerNames: string[];
  shipTo: string | null;
  shippingAddress: string | null;
  paymentInstrumentType: string | null;
  orderStatus: string | null;
}

const ORDER_ID_RE = /(\d{3}-\d{7}-\d{7})/;

function extractOrderId(text: string): string | null {
  return text.match(ORDER_ID_RE)?.[1] ?? null;
}

function extractAmount(text: string): number | null {
  const patterns = [
    /(?:Order Total|Grand Total|Total for this order|Total charged|Order total):?\s*\$?([\d,]+\.\d{2})/i,
    /\$([\d,]+\.\d{2})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (isFinite(n) && n > 0.01) return n;
    }
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function epochToIsoDate(epochMs: string): string {
  return new Date(parseInt(epochMs, 10)).toISOString().slice(0, 10);
}

function productsFromSubject(subject: string): string[] {
  const m = subject.match(/your amazon\.com order of (.+?)(?:\s*\(#|\s*$)/i);
  if (!m) return [];
  const name = m[1].trim();
  if (/^\d+ items?$/i.test(name)) return [];
  return [name];
}

function productsFromHtml(html: string): string[] {
  const names: string[] = [];
  const re = /<a\b[^>]*\/dp\/[^"']*["'][^>]*>\s*([^<]{4,120}?)\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const name = m[1].trim();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function extractShipping(text: string): { shipTo: string | null; address: string | null } {
  const m = text.match(/(?:Shipping to|Ships to|Ship to):?\s*([\w\s]+?)\s*\n([\w\s,\.]+,\s*[A-Z]{2}\s*\d{5})/i);
  if (m) return { shipTo: m[1].trim(), address: `${m[1].trim()}, ${m[2].trim()}` };
  return { shipTo: null, address: null };
}

export function parseAmazonEmail(message: GmailMessage): AmazonEmailOrder | null {
  const subject = getHeader(message, 'subject');
  const from = getHeader(message, 'from');

  const isAmazonSender = /auto-confirm@amazon\.com|shipment-tracking@amazon\.com|order-update@amazon\.com/i.test(from);
  if (!isAmazonSender) return null;

  const isOrderConfirmation = /your amazon\.com order of/i.test(subject);
  const isShipment = /has shipped/i.test(subject) && /amazon/i.test(subject);
  const isDelivery = /delivered/i.test(subject) && /amazon/i.test(subject);
  if (!isOrderConfirmation && !isShipment && !isDelivery) return null;

  const { text, html } = getMessageBody(message);
  const bodyText = text || stripHtml(html);

  const orderId = extractOrderId(subject) ?? extractOrderId(bodyText);
  if (!orderId) return null;

  const receivedDate = epochToIsoDate(message.internalDate);
  const totalAmount = isOrderConfirmation ? extractAmount(bodyText) : null;
  const orderDate = isOrderConfirmation ? receivedDate : null;
  const shipmentDate = isShipment ? receivedDate : null;

  const productNames = [
    ...productsFromHtml(html),
    ...productsFromSubject(subject),
  ].filter((v, i, a) => a.indexOf(v) === i);

  const { shipTo, address } = extractShipping(bodyText);

  return {
    orderId,
    orderDate,
    shipmentDate,
    totalAmount,
    productNames: productNames.length > 0 ? productNames : [`Amazon Order ${orderId}`],
    sellerNames: [],
    shipTo,
    shippingAddress: address,
    paymentInstrumentType: null,
    orderStatus: isOrderConfirmation ? 'Confirmed' : isShipment ? 'Shipped' : 'Delivered',
  };
}
```

#### `apps/cfo/src/lib/venmo-email.ts`

```ts
import type { GmailMessage } from './gmail';
import { getMessageBody, getHeader } from './gmail';
import type { VenmoContext } from '../types';

export interface VenmoEmailPayment {
  direction: VenmoContext['direction'];
  counterparty: string;
  memo: string | null;
  amount: number;
  date: string;
  gmailMessageId: string;
}

function epochToIsoDate(epochMs: string): string {
  return new Date(parseInt(epochMs, 10)).toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseAmount(raw: string): number | null {
  const n = parseFloat(raw.replace(/[$,]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}

export function parseVenmoEmail(message: GmailMessage): VenmoEmailPayment | null {
  const from = getHeader(message, 'from');
  if (!/venmo@venmo\.com/i.test(from)) return null;

  const subject = getHeader(message, 'subject');

  let direction: VenmoContext['direction'] | null = null;
  let counterparty: string | null = null;
  let subjectAmount: number | null = null;

  const receivedMatch = subject.match(/^(.+?)\s+paid you\s+\$([\d,]+\.\d{2})/i);
  if (receivedMatch) {
    direction = 'received';
    counterparty = receivedMatch[1].trim();
    subjectAmount = parseAmount(receivedMatch[2]);
  }

  const sentMatch = !direction && subject.match(/^You paid\s+(.+?)\s+\$([\d,]+\.\d{2})/i);
  if (sentMatch) {
    direction = 'sent';
    counterparty = sentMatch[1].trim();
    subjectAmount = parseAmount(sentMatch[2]);
  }

  const chargedMatch = !direction && subject.match(/^(.+?)\s+charged you\s+\$([\d,]+\.\d{2})/i);
  if (chargedMatch) {
    direction = 'charged';
    counterparty = chargedMatch[1].trim();
    subjectAmount = parseAmount(chargedMatch[2]);
  }

  if (!direction || !counterparty || subjectAmount === null) return null;

  const { text, html } = getMessageBody(message);
  const body = text || stripHtml(html);

  let memo: string | null = null;
  const forMatch = body.match(/For\s+"([^"]+)"/i) ?? body.match(/For\s+(.{3,80}?)(?:\n|$)/i);
  if (forMatch) memo = forMatch[1].trim();

  let amount = subjectAmount;
  if (!amount) {
    const bodyAmountMatch = body.match(/\$([\d,]+\.\d{2})/);
    if (bodyAmountMatch) amount = parseAmount(bodyAmountMatch[1]) ?? 0;
  }
  if (!amount) return null;

  return {
    direction,
    counterparty,
    memo,
    amount,
    date: epochToIsoDate(message.internalDate),
    gmailMessageId: message.id,
  };
}
```

#### `apps/cfo/src/lib/apple-email.ts`

```ts
import type { GmailMessage } from './gmail';
import { getMessageBody, getHeader } from './gmail';

export interface AppleReceiptItem {
  name: string;
  price: number;
}

export interface AppleEmailReceipt {
  receiptId: string | null;
  totalAmount: number;
  items: AppleReceiptItem[];
  date: string;
  gmailMessageId: string;
}

const RECEIPT_ID_RE = /\bM\d{9,}\b/;

function epochToIsoDate(epochMs: string): string {
  return new Date(parseInt(epochMs, 10)).toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parsePrice(raw: string): number | null {
  const n = parseFloat(raw.replace(/[$,]/g, ''));
  return isFinite(n) && n >= 0 ? n : null;
}

function extractTotal(text: string): number | null {
  const patterns = [
    /(?:order\s+)?total[:\s]+\$?([\d,]+\.\d{2})/i,
    /charged[:\s]+\$?([\d,]+\.\d{2})/i,
    /amount[:\s]+\$?([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parsePrice(m[1]);
      if (n !== null && n > 0) return n;
    }
  }
  return null;
}

function extractItemsFromHtml(html: string): AppleReceiptItem[] {
  const items: AppleReceiptItem[] = [];

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const rowText = stripHtml(rowHtml).trim();

    if (/^\s*$/.test(rowText)) continue;
    if (/\b(subtotal|tax|total|billed\s+to|apple\s+id)\b/i.test(rowText)) continue;

    const priceMatch = rowText.match(/\$([\d,]+\.\d{2})/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]);
    if (price === null) continue;

    const beforePrice = rowText.slice(0, rowText.lastIndexOf(priceMatch[0])).trim();
    const name = beforePrice
      .replace(/\bIn-App Purchase\b/gi, '')
      .replace(/\bSubscription\b/gi, '')
      .replace(/\b\d+\.\d\s*\(\d+\s*Ratings?\)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (name.length >= 2) {
      items.push({ name, price });
    }
  }

  return items;
}

function extractItemsFromText(text: string): AppleReceiptItem[] {
  const items: AppleReceiptItem[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (/^\s*$/.test(line)) continue;
    if (/\b(subtotal|tax|total|billed\s+to|apple\s+id|receipt|order\s+id)\b/i.test(line)) continue;

    const priceMatch = line.match(/\$([\d,]+\.\d{2})\s*$/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]);
    if (price === null) continue;

    const name = line.slice(0, line.lastIndexOf(priceMatch[0])).trim();
    if (name.length >= 2) {
      items.push({ name, price });
    }
  }

  return items;
}

export function parseAppleEmail(message: GmailMessage): AppleEmailReceipt | null {
  const from = getHeader(message, 'from');
  if (!/no_reply@email\.apple\.com/i.test(from)) return null;

  const subject = getHeader(message, 'subject');
  if (!/receipt/i.test(subject)) return null;

  const { text, html } = getMessageBody(message);
  const bodyText = text || stripHtml(html);

  const receiptId =
    subject.match(RECEIPT_ID_RE)?.[0] ??
    bodyText.match(RECEIPT_ID_RE)?.[0] ??
    null;

  const totalAmount = extractTotal(bodyText);
  if (!totalAmount) return null;

  const items = html
    ? extractItemsFromHtml(html)
    : extractItemsFromText(bodyText);

  const finalItems = items.length > 0 ? items : extractItemsFromText(bodyText);

  return {
    receiptId,
    totalAmount,
    items: finalItems,
    date: epochToIsoDate(message.internalDate),
    gmailMessageId: message.id,
  };
}
```

#### `apps/cfo/src/lib/etsy-email.ts`

```ts
import type { GmailMessage } from './gmail';
import { getMessageBody, getHeader } from './gmail';

export interface EtsyReceiptItem {
  name: string;
  price: number;
}

export interface EtsyEmailReceipt {
  orderId: string | null;
  shopName: string | null;
  totalAmount: number;
  items: EtsyReceiptItem[];
  date: string;
  dateIsFromBody: boolean;
  gmailMessageId: string;
}

function epochToIsoDate(epochMs: string): string {
  return new Date(parseInt(epochMs, 10)).toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parsePrice(raw: string): number | null {
  const n = parseFloat(raw.replace(/[$,]/g, ''));
  return isFinite(n) && n >= 0 ? n : null;
}

function extractOrderId(text: string): string | null {
  return (
    text.match(/(?:order\s*)?#(\d{9,})/i)?.[1] ??
    text.match(/\((\d{9,})\)/)?.[1] ??
    null
  );
}

function extractTotal(text: string): number | null {
  const re = /(?<![a-zA-Z])total[^$\n]{0,20}\$?([\d,]+\.\d{2})/gi;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last) {
    const n = parsePrice(last);
    if (n !== null && n > 0) return n;
  }
  const fallback = text.match(/charged[:\s]+\$?([\d,]+\.\d{2})/i)
    ?? text.match(/\$(\d+\.\d{2})/);
  if (fallback) {
    const n = parsePrice(fallback[1]);
    if (n !== null && n > 0) return n;
  }
  return null;
}

function extractDateFromBody(text: string): string | null {
  const months = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const mdy = new RegExp(`(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`, 'i');
  const iso = /\b(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/;

  const mdyMatch = text.match(mdy);
  if (mdyMatch) {
    const d = new Date(`${mdyMatch[1]} ${mdyMatch[2]}, ${mdyMatch[3]}`);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const isoMatch = text.match(iso);
  if (isoMatch) return isoMatch[0];
  return null;
}

function extractShopFromSubject(subject: string): string | null {
  return subject.match(/from\s+([^(]+?)(?:\s*\(|$)/i)?.[1]?.trim() ?? null;
}

function extractItemsFromHtml(html: string): EtsyReceiptItem[] {
  const items: EtsyReceiptItem[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowText = stripHtml(rowMatch[1]).trim();
    if (!rowText) continue;
    if (/\b(subtotal|shipping|tax|total|discount|coupon)\b/i.test(rowText)) continue;

    const priceMatch = rowText.match(/\$([\d,]+\.\d{2})/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]);
    if (price === null || price === 0) continue;

    const name = rowText.slice(0, rowText.lastIndexOf(priceMatch[0]))
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (name.length >= 2) items.push({ name, price });
  }

  return items;
}

function extractItemsFromText(text: string): EtsyReceiptItem[] {
  const items: EtsyReceiptItem[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (/\b(subtotal|shipping|tax|total|discount|coupon|receipt|order)\b/i.test(line)) continue;

    const priceMatch = line.match(/\$([\d,]+\.\d{2})\s*$/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]);
    if (price === null || price === 0) continue;

    const name = line.slice(0, line.lastIndexOf(priceMatch[0])).trim();
    if (name.length >= 2) items.push({ name, price });
  }
  return items;
}

export function parseEtsyEmail(message: GmailMessage): EtsyEmailReceipt | null {
  const subject = getHeader(message, 'subject');
  if (!/receipt|you just bought|order confirmed|etsy purchase|purchase from/i.test(subject)) return null;

  const { text, html } = getMessageBody(message);
  const bodyText = text || stripHtml(html);

  const orderId = extractOrderId(subject) ?? extractOrderId(bodyText);
  const shopName = extractShopFromSubject(subject)
    ?? bodyText.match(/(?:from|shop(?:ped\s+at)?)[:\s]+([A-Z][^$\n]{3,40}?)(?:\n|\s{2}|$)/)?.[1]?.trim()
    ?? null;

  const totalAmount = extractTotal(bodyText);
  if (!totalAmount) return null;

  const items = html ? extractItemsFromHtml(html) : [];
  const finalItems = items.length > 0 ? items : extractItemsFromText(bodyText);

  const bodyDate = extractDateFromBody(bodyText);

  return {
    orderId,
    shopName,
    totalAmount,
    items: finalItems,
    date: bodyDate ?? epochToIsoDate(message.internalDate),
    dateIsFromBody: bodyDate !== null,
    gmailMessageId: message.id,
  };
}
```

#### `apps/cfo/src/lib/nightly-email-sync.ts`

The orchestrator (349 lines) is reproduced fully below since it ties the pipelines together; it shares the `since-days` calculation, dedup-write-then-parse order, and per-vendor sync state update.

```ts
/**
 * Nightly email sync — runs as part of the 0 9 * * * cron.
 *
 * Pulls four categories of emails from the personal Gmail account
 * (using GOOGLE_OAUTH_REFRESH_TOKEN) and enriches matching bank transactions:
 *
 *   Amazon — order confirmation emails → match to credit card charge,
 *            store product names + shipping address for AI classification.
 *
 *   Venmo  — payment emails → match to ACH bank transaction,
 *            store counterparty + memo for AI classification.
 *
 *   Apple  — purchase receipt emails → match to APPLE.COM/BILL credit card
 *            charge, store item names for AI classification.
 *
 *   Etsy   — purchase receipt emails → match to ETSY credit card charge,
 *            store item names + shop name for AI classification.
 *
 * All pipelines share a single access-token refresh and write their
 * last-run time to email_sync_state so reruns search a tight window.
 * The *_email_processed tables act as dedup: already-seen message IDs
 * are skipped without re-fetching the full message.
 */

import type { Env } from '../types';
import { getEnvAccessToken, searchMessages, getMessage } from './gmail';
import { parseAmazonEmail } from './amazon-email';
import { parseVenmoEmail } from './venmo-email';
import { parseAppleEmail } from './apple-email';
import { parseEtsyEmail } from './etsy-email';
import { processAmazonOrders } from '../routes/amazon';
import { matchVenmoPayment, storeVenmoMatch } from './venmo';
import { matchAppleReceipt, storeAppleMatch } from './apple';
import { matchEtsyReceipt, storeEtsyMatch } from './etsy';

export interface NightlyEmailSyncSummary {
  started_at: string;
  finished_at: string;
  skipped: boolean;
  amazon: { emails_found: number; emails_processed: number; orders_stored: number; orders_matched: number; };
  venmo: { emails_found: number; emails_processed: number; payments_matched: number; payments_reclassified: number; };
  apple: { emails_found: number; emails_processed: number; receipts_matched: number; receipts_reclassified: number; };
  etsy: { emails_found: number; emails_processed: number; receipts_matched: number; receipts_reclassified: number; };
}

export async function runNightlyEmailSync(env: Env, lookbackDays?: number): Promise<NightlyEmailSyncSummary> {
  const startedAt = new Date().toISOString();
  const empty = {
    started_at: startedAt,
    finished_at: startedAt,
    skipped: false,
    amazon: { emails_found: 0, emails_processed: 0, orders_stored: 0, orders_matched: 0 },
    venmo: { emails_found: 0, emails_processed: 0, payments_matched: 0, payments_reclassified: 0 },
    apple: { emails_found: 0, emails_processed: 0, receipts_matched: 0, receipts_reclassified: 0 },
    etsy: { emails_found: 0, emails_processed: 0, receipts_matched: 0, receipts_reclassified: 0 },
  };

  if (!env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    console.log('[email-sync] GOOGLE_OAUTH_REFRESH_TOKEN not configured — skipping');
    return { ...empty, skipped: true };
  }

  const userId = env.WEB_UI_USER_ID ?? 'default';
  const accessToken = await getEnvAccessToken(env);

  await env.DB.prepare(`INSERT OR IGNORE INTO email_sync_state (user_id) VALUES (?)`).bind(userId).run();

  const state = await env.DB.prepare(
    `SELECT amazon_last_synced_at, venmo_last_synced_at, apple_last_synced_at, etsy_last_synced_at FROM email_sync_state WHERE user_id = ?`,
  ).bind(userId).first<{
    amazon_last_synced_at: string | null;
    venmo_last_synced_at: string | null;
    apple_last_synced_at: string | null;
    etsy_last_synced_at: string | null;
  }>();

  const [amazonResult, venmoResult, appleResult, etsyResult] = await Promise.all([
    syncAmazonEmails(env, userId, accessToken, state?.amazon_last_synced_at ?? null, lookbackDays),
    syncVenmoEmails(env, userId, accessToken, state?.venmo_last_synced_at ?? null, lookbackDays),
    syncAppleEmails(env, userId, accessToken, state?.apple_last_synced_at ?? null, lookbackDays),
    syncEtsyEmails(env, userId, accessToken, state?.etsy_last_synced_at ?? null, lookbackDays),
  ]);

  await env.DB.prepare(
    `UPDATE email_sync_state
     SET amazon_last_synced_at = datetime('now'),
         venmo_last_synced_at = datetime('now'),
         apple_last_synced_at = datetime('now'),
         etsy_last_synced_at = datetime('now')
     WHERE user_id = ?`,
  ).bind(userId).run();

  const summary: NightlyEmailSyncSummary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    skipped: false,
    amazon: amazonResult,
    venmo: venmoResult,
    apple: appleResult,
    etsy: etsyResult,
  };

  console.log('[email-sync] summary', summary);
  return summary;
}

// Amazon
async function syncAmazonEmails(env: Env, userId: string, accessToken: string, lastSyncedAt: string | null, lookbackDays?: number) {
  const sinceDays = lookbackDays ?? (lastSyncedAt
    ? Math.ceil((Date.now() - new Date(lastSyncedAt).getTime()) / 86_400_000) + 2
    : 90);
  const query = `from:(auto-confirm@amazon.com OR shipment-tracking@amazon.com) newer_than:${sinceDays}d`;
  const refs = await searchMessages(accessToken, query);

  const importId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO imports (id, user_id, source, status, transactions_found)
     VALUES (?, ?, 'amazon', 'running', ?)`,
  ).bind(importId, userId, refs.length).run();

  let emailsProcessed = 0, ordersStored = 0, ordersMatched = 0;
  try {
    for (const ref of refs) {
      const already = await env.DB.prepare(`SELECT id FROM amazon_email_processed WHERE gmail_message_id = ?`).bind(ref.id).first();
      if (already) continue;

      const message = await getMessage(accessToken, ref.id);
      const parsed = parseAmazonEmail(message);

      await env.DB.prepare(
        `INSERT OR IGNORE INTO amazon_email_processed (id, user_id, gmail_message_id, order_id)
         VALUES (?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), userId, ref.id, parsed?.orderId ?? null).run();

      if (!parsed || parsed.totalAmount === null) continue;
      emailsProcessed++;

      const orderKey = [parsed.orderId, parsed.shipmentDate ?? parsed.orderDate ?? 'unknown-date', parsed.totalAmount.toFixed(2)].join('|');
      const result = await processAmazonOrders(env, userId, importId, [{
        orderKey, orderId: parsed.orderId, orderDate: parsed.orderDate, shipmentDate: parsed.shipmentDate,
        totalAmount: parsed.totalAmount, quantityTotal: 1, productNames: parsed.productNames,
        sellerNames: parsed.sellerNames, orderStatus: parsed.orderStatus,
        paymentInstrumentType: parsed.paymentInstrumentType, shipTo: parsed.shipTo, shippingAddress: parsed.shippingAddress,
      }]);
      ordersStored += result.stored;
      ordersMatched += result.matched;
    }
    await env.DB.prepare(`UPDATE imports SET status='completed', transactions_imported=?, completed_at=datetime('now') WHERE id=?`).bind(ordersStored, importId).run();
  } catch (err) {
    await env.DB.prepare(`UPDATE imports SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`).bind(String(err), importId).run();
    throw err;
  }
  return { emails_found: refs.length, emails_processed: emailsProcessed, orders_stored: ordersStored, orders_matched: ordersMatched };
}

// Venmo / Apple / Etsy follow the same pattern; see source for full bodies.
```

The Venmo, Apple, and Etsy halves of `nightly-email-sync.ts` follow the exact same shape as Amazon: dedup-check, get message, dedup-write (unconditional), parse, match, store, increment counters. The matching/storing helpers (`matchVenmoPayment` / `storeVenmoMatch`, `matchAppleReceipt` / `storeAppleMatch`, `matchEtsyReceipt` / `storeEtsyMatch`) are in `src/lib/venmo.ts`, `src/lib/apple.ts`, `src/lib/etsy.ts` respectively (each ~100–125 lines).

---

## 4. Other External Integrations

| API | Purpose | Auth | Sent | Received | Source |
|---|---|---|---|---|---|
| **Anthropic Messages API** (`https://api.anthropic.com/v1/messages`) | Tool-forced transaction classification (`classify_transaction` tool); SMS-reply intent parsing; web-chat SSE responses | `x-api-key: $ANTHROPIC_API_KEY` header; `anthropic-version: 2023-06-01` | System prompt (with `cache_control: ephemeral`), transaction text/context (Amazon/Venmo/Apple/Etsy), tools array | `content[]` blocks with `tool_use.classify_transaction.input` | `src/lib/claude.ts:517-549, 574-621`; `src/lib/sms-claude.ts:121, 252` |
| **Anthropic Web Search** (server tool `web_search_20250305`) | Second-pass classifier for unknown merchants when first-pass confidence < 0.75; up to 4 multi-turn iterations | Same Anthropic API key | Tool definition includes `web_search`; the server runs the search and returns results inline | Search results in the same `content[]` array, terminated by `classify_transaction` tool_use | `src/lib/claude.ts:557-622` |
| **Teller** | Bank account + transaction sync (see §2) | HTTP Basic `<access_token>:` + mTLS in non-sandbox | account_id, date ranges, paging from_id | Accounts, transactions | `src/lib/teller.ts` |
| **Plaid** | Bank sync for Patelco + EastRise Credit Union (Venmo, Northwestern Mutual excluded) | `client_id` + `secret` in body | `/link/token/create`, `/item/public_token/exchange`, `/accounts/get`, `/transactions/sync` (cursor-paginated) | Plaid transactions, accounts | `src/lib/plaid.ts:70-87` |
| **Google OAuth 2.0** | Refresh access tokens for Gmail | `client_id`+`client_secret`+`refresh_token`+`grant_type=refresh_token` to `https://oauth2.googleapis.com/token` | Form-encoded credentials | `access_token` (short-lived) | `src/lib/gmail.ts:34-48` |
| **Gmail v1** | Search + fetch personal email (Amazon/Venmo/Apple/Etsy) | `Authorization: Bearer <access_token>` | Search query `q`, `pageToken`, message ids | `messages[]` refs, full `Message` with `payload.parts[]` and `internalDate` | `src/lib/gmail.ts:61-93` |
| **Twilio Messaging** | Outbound SMS for the categorization gamification loop | HTTP Basic `<SID>:<authToken>` to `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json` | `From`, `To` (E.164), `Body` form fields | `{sid, status}` JSON | `src/lib/twilio.ts:46-62` |
| **Twilio inbound webhook** | Receive SMS replies at `POST /sms/inbound` | Server-side: `X-Twilio-Signature` HMAC-SHA1 of (url + sorted form params) using `TWILIO_AUTH_TOKEN` | n/a (we receive) | Form-encoded `MessageSid`, `Body`, `From`, etc. | `src/lib/twilio.ts:81-102`; `src/lib/sms-inbound.ts` |
| **Cloudflare R2** (binding `BUCKET`) | Bookkeeping notes (`bookkeeping-notes/<userId>/<entity>.md`), receipt attachments referenced by `attachments.r2_key`, filing snapshots referenced by `filing_snapshots.r2_key` | Binding (no auth at app layer) | `put(key, content)`, `get(key)` | text/binary | `src/lib/bookkeeping-notes.ts`; uses elsewhere in routes |
| **Fleet observability D1** (`AGENTBUILDER_CORE_DB`) | `runCron` writes per-invocation `cron_runs` + `cron_errors` rows | Binding | Insert | n/a | `@agentbuilder/observability`, called from `src/index.ts:475-498` |

Not used by the CFO (despite being available in the workspace): `@agentbuilder/auth-google`, `@agentbuilder/auth-github`, `@agentbuilder/credential-vault`, `@agentbuilder/crypto`, `@agentbuilder/extract-article`, `@agentbuilder/registry`. The Anthropic SDK is also unused — every call is raw `fetch`. Model is hardcoded `claude-opus-4-6` in three places in `claude.ts`.

---

## 5. Data Migration Assessment

This assessment is based on the **shape** of the data the schema supports. Volume and quality come from the production DB, which is not in this repo.

### 5a. Categorized transaction data currently in the schema

Each `transactions` row has at most one **current** classification (`classifications` PK is `transaction_id`) plus a per-change `classification_history` audit trail. The classification carries:

- `entity` enum: `elyse_coaching | jeremy_coaching | airbnb_activity | family_personal` (CHECK-constrained, but the seeded `business_entities.slug` uses `airbnb`/`family` instead — the entity strings stored in `classifications` are a separate enumeration).
- `category_tax` (free TEXT — Schedule C/E line slugs)
- `category_budget` (free TEXT — `budget_categories.slug`-ish)
- `confidence REAL` (0–1)
- `method` enum: `rule | ai | manual | historical`
- `reason_codes TEXT` (free-form list)
- `review_required INTEGER (0|1)`
- `is_locked INTEGER (0|1)` — once 1, blocks email-pipeline reclassification
- `business_entity_id` / `chart_of_account_id` FKs into the per-user category trees
- `expense_type` (`recurring | one_time | NULL`)
- `cut_status` (`flagged | complete | NULL`)
- `classified_at`, `classified_by`

Plus optional one-to-many `transaction_splits` rows for transactions split across entities/categories, and `review_queue` rows for items awaiting human resolution.

### 5b. Transaction count

Not knowable from this repo. The `pre-migration-backup.sql` snapshot inserts schema only (no domain rows). No fixtures or test data exist. The Claude system prompt mentions specific transaction counts per merchant (e.g. "GONG IO INC … 46 txns", "PATELCO … 28 txns", "KATSAM … 27 txns concentrated in June 2025"), which suggests the dataset is at least in the low hundreds for top merchants — but those numbers are static prompt text, not a query.

### 5c. Categorization fields on transactions

Per row, after a successful classification pass:

| Field | Type | Required | Notes |
|---|---|---|---|
| `transaction_id` | TEXT FK | yes | One classification per transaction (UNIQUE) |
| `entity` | enum | no (NULLable) | Always set in practice but no NOT NULL |
| `business_entity_id` | FK | no | Set when entity is recognised |
| `chart_of_account_id` | FK | no | Set when category resolves to the seeded CoA |
| `category_tax` | TEXT | no | Free-text; expected to match a CoA `code` |
| `category_budget` | TEXT | no | Free-text; expected to match `budget_categories.slug` |
| `confidence` | REAL | no | 0–1 |
| `method` | enum | no | `rule | ai | manual | historical` |
| `reason_codes` | TEXT | no | Free-form |
| `review_required` | 0/1 | NOT NULL default 0 | |
| `is_locked` | 0/1 | NOT NULL default 0 | Manual locks survive AI reclassification |
| `expense_type` | enum or NULL | NULL = recurring | One-off flag for forecasting |
| `cut_status` | enum or NULL | NULL = no opinion | Eliminate-tracker |
| `classified_at` | TEXT | NOT NULL | datetime('now') default |
| `classified_by` | TEXT | NOT NULL default 'system' | |

There is no explicit "approved" boolean; approval status is encoded as `review_required = 0` AND `review_queue.status = 'resolved'`.

### 5d. What would a migration to a new Postgres schema require?

The audit is being asked to assess this, not recommend it. Below is a factual map of what would carry over cleanly vs. need transformation, based purely on what the data contains.

**Clean SQLite→Postgres mappings (types and shapes line up):**

| CFO D1 table | Notes |
|---|---|
| `users`, `business_entities`, `chart_of_accounts` | Plain TEXT PKs (UUIDs). UNIQUE constraints already declared. |
| `accounts`, `teller_enrollments`, `plaid_items` | Same. `access_token` columns are plaintext TEXT — migrate value carries; encryption decision is a separate axis. |
| `transactions` | `amount` is `REAL`; Postgres `numeric(12,2)` is a natural target. `posted_date` and `created_at`/`completed_at` are TEXT in SQLite (ISO 8601 strings); Postgres `date`/`timestamptz` would require a cast on import. |
| `classifications`, `classification_history`, `transaction_splits` | Enum CHECK constraints → Postgres ENUMs or CHECK. |
| `rules` | Same. |
| `review_queue` | Same. |
| `budget_categories`, `budget_targets`, `income_targets` | Same. |
| `amazon_orders`, `amazon_transaction_matches` | `product_names`/`seller_names` are stored as TEXT (sometimes JSON-encoded, sometimes a single name with try/catch fallback — see `loadAmazonContext` in `lib/amazon.ts:248-251`). A Postgres `text[]` or `jsonb` target needs the inconsistent input normalised first. |
| `venmo_email_matches`, `apple_email_matches`, `etsy_email_matches` | `items_json` is TEXT containing JSON arrays of `{name, price}`. Natural Postgres target is `jsonb`; cast is safe assuming the strings parse. |
| `*_email_processed` dedup tables | Plain. |
| `email_sync_state` | Plain. |
| `sms_persons`, `sms_sessions`, `sms_messages`, `sms_outcomes`, `sms_routing_overrides` | `preferred_send_slots` (JSON in TEXT), `batch_json` (TEXT containing structured array per migration 0011 comment) → `jsonb`. |
| `attachments`, `filing_snapshots` | `r2_key` references a separate object store; storage migration is orthogonal. |

**Tables needing transformation:**

- `imports.tax_year` is left in place since 0012, but always NULL for new rows. Migrate-as-is or drop.
- `business_entities.slug` is seeded as `airbnb`/`family` (`src/routes/setup.ts:37-41`) but the CHECK-constrained classification entity strings are `airbnb_activity`/`family_personal`. The two enums must be reconciled (or the FK relationship made explicit) before a clean Postgres model emerges. The repo has no code that derives one from the other.
- `tax_categories` (added in 0017) coexists with `chart_of_accounts` and the hardcoded `SCHEDULE_C_CATEGORIES`/`AIRBNB_CATEGORIES` constants in `src/types.ts`. Three sources of truth.
- The `accounts` table still carries Plaid columns (`plaid_account_id`, `plaid_item_id`) plus Teller columns (`teller_account_id`, `teller_enrollment_id`); a normalised Postgres model would likely choose a single polymorphic provider key.
- `category_plaid` is a misnamed column on `transactions` — it now stores Teller's category as well (see `syncAccountTransactions` in `routes/teller.ts:79, 90`). Rename on migration or document.
- The `classifications.entity` text-enum and `business_entities.id` FK overlap conceptually but are independently editable.

**Data worth migrating vs. starting fresh** — purely structural observations, no recommendation:

- The auditable history surface (`classification_history`, `imports.error_message`, `cron_runs` in fleet DB) is what makes "what did the system decide and when" answerable; dropping this loses that audit trail.
- Cached enrichment context (Amazon order products, Venmo memos, Apple/Etsy item lists, shipping address) feeds the AI classifier. Re-fetching from Gmail is bounded by Gmail's history window — the `*_email_processed` dedup tables prevent re-fetching by design, so dropping them would force a re-scan.
- Learned rules in `rules` are produced both manually (Tiller AutoCat import via `POST /rules/import-autocat`) and from manual classifications via `maybeLearnRuleFromManualClassification` in `src/lib/learned-rules.ts`. Recreating these requires the same source signals.

### 5e. Data-quality issues the schema permits or invites

Listed factually, without prescription:

- **Slug-vs-enum mismatch.** `business_entities.slug ∈ {elyse_coaching, jeremy_coaching, airbnb, family}` while `classifications.entity ∈ {elyse_coaching, jeremy_coaching, airbnb_activity, family_personal}`. There is no DB constraint linking them; the application maps them by convention only.
- **Plain TEXT category fields.** `classifications.category_tax`, `classifications.category_budget`, and `transaction_splits.category_tax` are bare TEXT with no FK into the chart of accounts. Migration 0007's comment explicitly notes this is intentional ("classifications pre-date the budget feature and may contain legacy slugs"), so historical rows may carry slugs that no longer exist in any CoA.
- **NULLable classification.** `classifications.entity` is NULLable; a row can exist with `transaction_id` and `method` but no entity. The downstream filtering in routes/transactions.ts inner-joins on `classifications`, so unclassified rows show only when explicitly queried.
- **Untracked orphans (FKs without ON DELETE).** `transactions.account_id → accounts.id` and `transactions.import_id → imports.id` have no ON DELETE rule. Deleting an account or import row is blocked by SQLite's default RESTRICT — but the in-app `DELETE /imports/:id` and `DELETE /imports` handlers exist (`src/routes/imports.ts`) and would need to clear transactions first.
- **Pending/posted reconciliation.** `syncAccountTransactions` deletes pending transactions that disappear from Teller (`removeMissingPendingTransactions`). If a sync misses a window (cron failure, enrollment disconnected), pending rows can linger.
- **Dedup hash sensitivity.** The dedup hash uses `accountId | postedDate | amount.toFixed(2) | description`. A bank that later changes the description (Amazon often does) will hash differently → potential duplicate. Mitigated by the Teller-specific `teller_transaction_id` UNIQUE index, but CSV imports rely only on the SHA-256.
- **Dedup-write-before-parse.** The four email pipelines insert into `*_email_processed` before checking whether the parser succeeded; a parse failure permanently shelves the message id. A Postgres migration carrying these tables forward inherits the shelved set.
- **`amazon_orders.product_names`/`seller_names` typing.** Stored as TEXT, sometimes JSON-array, sometimes a single name (`lib/amazon.ts:248-252` has a try/catch fallback). A `jsonb` Postgres target must accept either.
- **`category_plaid` mislabel.** The column on `transactions` carries Teller categories now; the historical name is misleading.
- **Plaintext credentials.** `teller_enrollments.access_token`, `plaid_items.access_token` are TEXT — no encryption layer in code (no `@agentbuilder/credential-vault` use).
- **Two-source-of-truth for categories.** `chart_of_accounts` rows (seeded from `src/types.ts` constants in `POST /setup`) and the separate `tax_categories` table (migration 0017_tax_categories) both define Schedule C/E categories. The audit did not determine which surface is canonical for new rows; `src/routes/tax-categories.ts` exists at 133 lines.
- **Duplicate migration prefixes.** Migrations `0015_cut_status.sql` + `0015_gmail_enrollments.sql` and `0017_apple_email_sync.sql` + `0017_tax_categories.sql` share numeric prefixes; Wrangler applies in lexicographic order, so the second-sorted file in each pair runs after the first regardless of intent.

---

End of report 02.
