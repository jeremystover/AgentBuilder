-- Module 5 (Scenarios) — Phase 1: Account Setup.
--
-- Schema translated from docs/cfo-scenarios-supplemental-spec.md (which
-- used SQLite types) to Postgres: REAL → NUMERIC(20,2) for money,
-- INTEGER booleans → BOOLEAN, TEXT timestamps → TIMESTAMPTZ, TEXT dates
-- → DATE, and `config_json` is JSONB (not TEXT) for queryability.

CREATE TABLE scenario_accounts (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN (
                       'checking', 'brokerage', 'trad_401k', 'roth_ira',
                       'real_estate_primary', 'real_estate_investment',
                       'mortgage', 'heloc', 'loan',
                       'private_equity', '529', 'social_security',
                       'other_asset', 'other_liability'
                     )),
  asset_or_liability TEXT NOT NULL CHECK (asset_or_liability IN ('asset', 'liability')),
  entity_id          TEXT REFERENCES entities(id),
  current_balance    NUMERIC(20,2),
  teller_account_id  TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scenario_accounts_active ON scenario_accounts(is_active) WHERE is_active;

CREATE TABLE account_type_config (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id  TEXT NOT NULL UNIQUE REFERENCES scenario_accounts(id) ON DELETE CASCADE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE account_rate_schedule (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id     TEXT NOT NULL REFERENCES scenario_accounts(id) ON DELETE CASCADE,
  base_rate      NUMERIC(7,5) NOT NULL,
  effective_date DATE NOT NULL,
  notes          TEXT
);

CREATE INDEX idx_account_rate_schedule_account
  ON account_rate_schedule(account_id, effective_date);

CREATE TABLE account_balance_history (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id    TEXT NOT NULL REFERENCES scenario_accounts(id) ON DELETE CASCADE,
  balance       NUMERIC(20,2) NOT NULL,
  recorded_date DATE NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'teller_sync')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_account_balance_history_account
  ON account_balance_history(account_id, recorded_date DESC);
