# Build Prompt — Phase 1a: Scaffold, Database & Teller Sync

**Session goal:** Create the `apps/cfo/` app in the AgentBuilder monorepo, set up Neon Postgres via Hyperdrive, write the full database schema for Modules 1 and 2, and get Teller sync running correctly.

**Before writing any code:** Read `apps/cfo/CLAUDE.md` in full. Then read `apps/cfo/src/lib/teller.ts` and `apps/cfo/src/lib/dedup.ts` — you will be adapting these.

**Do not build any UI in this session.** Worker, database, and Teller sync only.

-----

## Step 1: Scaffold the app

Create `apps/cfo/` with this structure:

```
apps/cfo/
├── package.json
├── wrangler.toml
├── tsconfig.json
├── tsconfig.web.json
├── vite.config.ts
├── tailwind.config.ts         (copy from apps/cfo/tailwind.config.ts, update content glob)
├── postcss.config.js          (copy from apps/cfo)
├── vitest.config.ts           (copy from apps/cfo)
├── CLAUDE.md                  (already exists — do not modify)
├── migrations/
│   └── 0001_initial.sql
└── src/
    ├── index.ts
    ├── types.ts
    ├── lib/
    │   ├── teller.ts          (adapted from apps/cfo/src/lib/teller.ts)
    │   └── dedup.ts           (copied from apps/cfo/src/lib/dedup.ts)
    └── routes/
        └── health.ts
```

### `package.json`

Follow the CFO’s `package.json` as a model. Dependencies must include:

```json
{
  "dependencies": {
    "@agentbuilder/auth-google": "workspace:*",
    "@agentbuilder/llm": "workspace:*",
    "@agentbuilder/observability": "workspace:*",
    "@agentbuilder/web-ui-kit": "workspace:*"
  }
}
```

Do NOT declare `@agentbuilder/core` or `@agentbuilder/llm` unless you actually import them in source. The CFO declares both but imports neither — don’t repeat that.

### `wrangler.toml`

The existing `wrangler.toml` in `apps/cfo/` will be replaced. The new one keeps `name = "cfo"` and updates the bindings. Key changes from the old config: D1 binding (`DB`) is replaced by Hyperdrive (`HYPERDRIVE`); R2 and Queue bindings are added.

```toml
name = "cfo"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist"
binding = "ASSETS"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = ""  # Set after Hyperdrive config is created — see Step 2

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "cfo-storage"

[[queues.producers]]
binding = "SCENARIO_QUEUE"
queue = "cfo-scenarios"

[[queues.consumers]]
queue = "cfo-scenarios"
max_batch_size = 1
max_retries = 3

[vars]
ENVIRONMENT = "production"

# Crons
[triggers]
crons = ["0 9 * * *"]   # Nightly sync — UTC (05:00 ET)
```

**Secrets needed (do not hardcode, document in a comment):**

- `WEB_UI_PASSWORD` — for cookie auth
- `MCP_HTTP_KEY` — for MCP endpoint auth
- `EXTERNAL_API_KEY` — for REST API auth

-----

## Step 2: Neon + Hyperdrive setup instructions

Write a `docs/setup-neon.md` file inside `apps/cfo/` with step-by-step instructions for the human to follow (not automated):

1. Create a Neon project at neon.tech — name it `family-finance`
1. Copy the connection string
1. In Cloudflare Dashboard → Workers & Pages → Hyperdrive → Create configuration
- Name: `cfo-db`
- Paste the Neon connection string
- Copy the generated Hyperdrive ID
1. Paste the Hyperdrive ID into `wrangler.toml` `[[hyperdrive]] id = ""`
1. Run migrations: `wrangler d1 migrations apply` is NOT used here — Neon uses standard Postgres. Document how to run `psql` or the Neon console to execute `migrations/0001_initial.sql`

-----

## Step 3: Database schema

Create `apps/cfo/migrations/0001_initial.sql` with the complete schema for Modules 1 and 2. Use Postgres types (not SQLite).

```sql
-- =============================================
-- CORE / IDENTITY
-- =============================================

CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('personal', 'schedule_c', 'schedule_e')),
  slug        TEXT NOT NULL UNIQUE,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default entities
INSERT INTO entities (id, name, type, slug) VALUES
  ('ent_personal',        'Personal / Family',    'personal',    'personal'),
  ('ent_whitford',        'Whitford House',        'schedule_e',  'whitford_house'),
  ('ent_elyse_coaching',  'Elyse Coaching',        'schedule_c',  'elyse_coaching'),
  ('ent_jeremy_coaching', 'Jeremy Coaching',       'schedule_c',  'jeremy_coaching');

CREATE TABLE categories (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('personal', 'schedule_c', 'schedule_e', 'all')),
  category_set    TEXT NOT NULL CHECK (category_set IN ('schedule_c', 'schedule_e', 'budget', 'custom')),
  form_line       TEXT,        -- IRS line number for tax categories (e.g. "Part II Line 8")
  description     TEXT,        -- Used by AI classifier: what belongs in this category
  is_active       BOOLEAN NOT NULL DEFAULT true,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schedule C categories (seed with standard IRS Part I income + Part II expense lines)
-- Schedule E categories (seed with rental income + expense lines)  
-- Budget categories (seed with common personal spending categories)
-- NOTE: Full seed data in migrations/0002_seed_categories.sql (separate file)

-- =============================================
-- MODULE 1: GATHER
-- =============================================

CREATE TABLE gather_accounts (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  institution           TEXT,
  type                  TEXT NOT NULL CHECK (type IN ('checking', 'savings', 'credit', 'investment', 'loan', 'other')),
  source                TEXT NOT NULL CHECK (source IN ('teller', 'email', 'chrome_extension', 'manual')),
  entity_id             TEXT REFERENCES entities(id),
  is_active             BOOLEAN NOT NULL DEFAULT true,
  teller_account_id     TEXT UNIQUE,
  teller_enrollment_id  TEXT,
  last_synced_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teller_enrollments (
  id              TEXT PRIMARY KEY,
  enrollment_id   TEXT NOT NULL UNIQUE,
  access_token    TEXT NOT NULL,   -- NOTE: plaintext for now; encrypt in future
  institution_id  TEXT,
  institution_name TEXT,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_log (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source              TEXT NOT NULL,   -- 'teller' | 'email_amazon' | etc.
  account_id          TEXT REFERENCES gather_accounts(id),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  transactions_found  INTEGER NOT NULL DEFAULT 0,
  transactions_new    INTEGER NOT NULL DEFAULT 0,
  error_message       TEXT
);

CREATE TABLE raw_transactions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id      TEXT REFERENCES gather_accounts(id),
  source          TEXT NOT NULL CHECK (source IN ('teller', 'email_amazon', 'email_venmo', 'email_apple', 'email_etsy', 'chrome_extension', 'manual')),
  external_id     TEXT,           -- teller_transaction_id, etc.
  date            DATE NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  description     TEXT NOT NULL,
  merchant        TEXT,
  raw_payload     JSONB,          -- nulled out after transaction is approved
  supplement_json JSONB,          -- enrichment from email/chrome: {vendor_context}
  dedup_hash      TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'waiting', 'ready', 'processed')),
  waiting_for     TEXT,           -- e.g. 'email_venmo' — what supplement is pending
  ingest_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX idx_raw_transactions_status ON raw_transactions(status);
CREATE INDEX idx_raw_transactions_account ON raw_transactions(account_id);
CREATE INDEX idx_raw_transactions_date ON raw_transactions(date DESC);

-- =============================================
-- MODULE 2: REVIEW
-- =============================================

CREATE TABLE transactions (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  raw_id                  TEXT REFERENCES raw_transactions(id),
  account_id              TEXT REFERENCES gather_accounts(id),
  date                    DATE NOT NULL,
  amount                  NUMERIC(12,2) NOT NULL,
  description             TEXT NOT NULL,
  merchant                TEXT,
  entity_id               TEXT REFERENCES entities(id),
  category_id             TEXT REFERENCES categories(id),
  classification_method   TEXT CHECK (classification_method IN ('rule', 'ai', 'manual', 'historical')),
  ai_confidence           NUMERIC(4,3),          -- 0.000 to 1.000
  ai_notes                TEXT,                  -- AI reasoning + factors considered
  human_notes             TEXT,
  is_transfer             BOOLEAN NOT NULL DEFAULT false,
  is_reimbursable         BOOLEAN NOT NULL DEFAULT false,
  is_locked               BOOLEAN NOT NULL DEFAULT false,
  status                  TEXT NOT NULL DEFAULT 'pending_review'
                          CHECK (status IN ('pending_review', 'approved', 'excluded')),
  teller_transaction_id   TEXT UNIQUE,
  approved_at             TIMESTAMPTZ,
  approved_by             TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_date ON transactions(date DESC);
CREATE INDEX idx_transactions_entity ON transactions(entity_id);
CREATE INDEX idx_transactions_category ON transactions(category_id);
CREATE INDEX idx_transactions_account ON transactions(account_id);

CREATE TABLE transaction_splits (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL,
  entity_id     TEXT REFERENCES entities(id),
  category_id   TEXT REFERENCES categories(id),
  notes         TEXT
);

CREATE TABLE rules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  match_json      JSONB NOT NULL,  -- {description_contains, description_starts_with, amount_min, amount_max, account_id, source}
  entity_id       TEXT REFERENCES entities(id),
  category_id     TEXT REFERENCES categories(id),
  created_by      TEXT NOT NULL DEFAULT 'system' CHECK (created_by IN ('system', 'user')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  match_count     INTEGER NOT NULL DEFAULT 0,
  last_matched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_file (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version     INTEGER NOT NULL DEFAULT 1,
  content     TEXT NOT NULL,     -- LLM prompt injection: learned patterns and heuristics
  token_count INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed with empty knowledge file
INSERT INTO knowledge_file (id, version, content) VALUES
  ('kf_main', 1, '# Classification Knowledge\n\nNo patterns learned yet.');

CREATE TABLE postmortem_runs (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  transactions_analyzed   INTEGER NOT NULL DEFAULT 0,
  rules_proposed          INTEGER NOT NULL DEFAULT 0,
  rules_accepted          INTEGER NOT NULL DEFAULT 0,
  knowledge_updated       BOOLEAN NOT NULL DEFAULT false
);

-- Sessions table (for @agentbuilder/web-ui-kit)
CREATE TABLE web_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'default',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
```

-----

## Step 4: `src/types.ts`

Define the `Env` interface and core domain types. Model this on the CFO’s `src/types.ts` but only include what’s needed now.

```typescript
export interface Env {
  // Database
  HYPERDRIVE: Hyperdrive;

  // Storage
  STORAGE: R2Bucket;

  // Queue
  SCENARIO_QUEUE: Queue;

  // Assets (SPA)
  ASSETS: Fetcher;

  // Auth (web-ui-kit)
  WEB_UI_PASSWORD: string;
  EXTERNAL_API_KEY: string;
  MCP_HTTP_KEY: string;
  WEB_UI_USER_ID?: string;

  // LLM
  ANTHROPIC_API_KEY: string;

  // Teller
  TELLER_APPLICATION_ID: string;
  TELLER_ENV: string;
  TELLER_MTLS?: string;

  // Fleet observability
  AGENTBUILDER_CORE_DB: D1Database;
}

// Helpers — same pattern as CFO
export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
```

-----

## Step 5: Adapt `src/lib/teller.ts`

Copy `apps/cfo/src/lib/teller.ts` into `apps/cfo/src/lib/teller.ts`. Make these changes only:

1. Replace `import type { Env } from '../types'` with a narrow interface:
   
   ```typescript
   export interface TellerEnv {
     TELLER_APPLICATION_ID: string;
     TELLER_ENV: string;
     TELLER_MTLS?: string;
   }
   ```
1. Update all function signatures from `env: Env` to `env: TellerEnv`
1. No other changes — the HTTP client logic is correct as-is

-----

## Step 6: Copy `src/lib/dedup.ts`

Copy `apps/cfo/src/lib/dedup.ts` verbatim into `apps/cfo/src/lib/dedup.ts`. No changes needed.

-----

## Step 7: Teller sync route

Create `apps/cfo/src/routes/teller.ts`. This is a rewrite against Postgres, but **preserve these two algorithms exactly** from `apps/cfo/src/routes/teller.ts`:

**Algorithm 1 — Pending→posted reconciliation** (CFO lines ~94–113):
When a new posted transaction arrives, check whether a pending transaction exists for the same account with:

- Amount matches exactly
- Description similarity (use `cleanDescription` from `dedup.ts`)
- Date within ±10 days

If match found: update the existing row to posted status rather than inserting a duplicate.

**Algorithm 2 — Disconnect detection** (CFO lines ~405–413, ~424–430):
When a Teller API call returns an error, check the error message for `enrollment.disconnected`. If found, update the enrollment status and return a structured error that the UI can surface as “reconnect required” rather than a generic failure.

The route should expose:

- `POST /teller/sync` — sync all enrolled accounts (or specific account_ids)
- `POST /teller/enroll` — start a new Teller enrollment
- `GET /teller/accounts` — list enrolled accounts with last-sync status
- `DELETE /teller/enrollments/:id` — remove an enrollment

Each synced transaction writes to `raw_transactions` with `source = 'teller'` and `status = 'staged'`. It does NOT touch the `transactions` table — that is Module 2’s job.

-----

## Step 8: Worker entrypoint

Create `apps/cfo/src/index.ts` following the CFO pattern exactly:

- Same `ROUTES` array pattern with regex routing
- Same CORS handling
- Same `try/catch` per route
- `fetch` handler + `scheduled` handler
- `scheduled` runs `handleNightlySync(env)` which calls Teller sync

The nightly sync cron should:

1. Log start via `runCron` from `@agentbuilder/observability`
1. Call Teller sync for all active accounts
1. Log completion

-----

## Step 9: Health check route

Create `apps/cfo/src/routes/health.ts` with a `GET /health` handler that returns:

```json
{
  "status": "ok",
  "app": "cfo",
  "db": "connected",
  "timestamp": "2026-..."
}
```

Test the Neon connection by running `SELECT 1` via `HYPERDRIVE`.

-----

## Step 10: CI workflow

The `.github/workflows/deploy-cfo.yml` workflow already exists and already points to `apps/cfo/**`. No changes needed. Verify it runs `pnpm web:build && wrangler deploy` — if so, it will work for the new system without modification.

-----

## Acceptance Criteria

This session is complete when:

1. `apps/cfo/` exists with all config files and compiles without errors (`pnpm typecheck`)
1. `migrations/0001_initial.sql` is valid Postgres SQL (all tables created, no syntax errors)
1. `src/lib/teller.ts` compiles and the narrow `TellerEnv` interface is used throughout
1. `GET /health` returns 200 with a successful Neon connection test
1. `POST /teller/sync` completes without errors on a test call (even if no enrollments exist yet)
1. Nightly cron handler runs without throwing
1. CI workflow file exists and references the correct paths

**Do not proceed to Phase 1b until these are verified.**