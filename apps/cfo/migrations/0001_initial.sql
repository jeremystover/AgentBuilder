-- CFO initial schema — Modules 1 (Gather) and 2 (Review).
-- Target: Neon (Postgres 15+). Run via psql or the Neon SQL editor.

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

INSERT INTO entities (id, name, type, slug) VALUES
  ('ent_personal',        'Personal / Family', 'personal',   'personal'),
  ('ent_whitford',        'Whitford House',    'schedule_e', 'whitford_house'),
  ('ent_elyse_coaching',  'Elyse Coaching',    'schedule_c', 'elyse_coaching'),
  ('ent_jeremy_coaching', 'Jeremy Coaching',   'schedule_c', 'jeremy_coaching');

CREATE TABLE categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('personal', 'schedule_c', 'schedule_e', 'all')),
  category_set  TEXT NOT NULL CHECK (category_set IN ('schedule_c', 'schedule_e', 'budget', 'custom')),
  form_line     TEXT,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schedule C / Schedule E / budget seed data lives in 0002_seed_categories.sql.

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
  id                TEXT PRIMARY KEY,
  enrollment_id     TEXT NOT NULL UNIQUE,
  access_token      TEXT NOT NULL,
  institution_id    TEXT,
  institution_name  TEXT,
  last_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync_log (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source              TEXT NOT NULL,
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
  external_id     TEXT,
  date            DATE NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  description     TEXT NOT NULL,
  merchant        TEXT,
  raw_payload     JSONB,
  supplement_json JSONB,
  dedup_hash      TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'waiting', 'ready', 'processed')),
  waiting_for     TEXT,
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
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  raw_id                 TEXT REFERENCES raw_transactions(id),
  account_id             TEXT REFERENCES gather_accounts(id),
  date                   DATE NOT NULL,
  amount                 NUMERIC(12,2) NOT NULL,
  description            TEXT NOT NULL,
  merchant               TEXT,
  entity_id              TEXT REFERENCES entities(id),
  category_id            TEXT REFERENCES categories(id),
  classification_method  TEXT CHECK (classification_method IN ('rule', 'ai', 'manual', 'historical')),
  ai_confidence          NUMERIC(4,3),
  ai_notes               TEXT,
  human_notes            TEXT,
  is_transfer            BOOLEAN NOT NULL DEFAULT false,
  is_reimbursable        BOOLEAN NOT NULL DEFAULT false,
  is_locked              BOOLEAN NOT NULL DEFAULT false,
  status                 TEXT NOT NULL DEFAULT 'pending_review'
                         CHECK (status IN ('pending_review', 'approved', 'excluded')),
  teller_transaction_id  TEXT UNIQUE,
  approved_at            TIMESTAMPTZ,
  approved_by            TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_date ON transactions(date DESC);
CREATE INDEX idx_transactions_entity ON transactions(entity_id);
CREATE INDEX idx_transactions_category ON transactions(category_id);
CREATE INDEX idx_transactions_account ON transactions(account_id);

CREATE TABLE transaction_splits (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount          NUMERIC(12,2) NOT NULL,
  entity_id       TEXT REFERENCES entities(id),
  category_id     TEXT REFERENCES categories(id),
  notes           TEXT
);

CREATE TABLE rules (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  match_json      JSONB NOT NULL,
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
  content     TEXT NOT NULL,
  token_count INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO knowledge_file (id, version, content) VALUES
  ('kf_main', 1, '# Classification Knowledge\n\nNo patterns learned yet.');

CREATE TABLE postmortem_runs (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  transactions_analyzed  INTEGER NOT NULL DEFAULT 0,
  rules_proposed         INTEGER NOT NULL DEFAULT 0,
  rules_accepted         INTEGER NOT NULL DEFAULT 0,
  knowledge_updated      BOOLEAN NOT NULL DEFAULT false
);

-- Web session store for @agentbuilder/web-ui-kit.
CREATE TABLE web_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'default',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
