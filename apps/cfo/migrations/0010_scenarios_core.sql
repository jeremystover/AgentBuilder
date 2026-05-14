-- Module 5 (Scenarios) — projection engine tables.
--
-- These tables are created in Phase 5 even though the engine that
-- writes to them is built in Phase 6. Translated from the supplemental
-- spec's SQLite definitions to Postgres types.

CREATE TABLE scenarios (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name                  TEXT NOT NULL,
  start_date            DATE NOT NULL,
  end_date              DATE NOT NULL,
  plan_id               TEXT REFERENCES plans(id),
  account_ids_json      JSONB,
  allocation_rules_json JSONB,
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'running', 'complete', 'failed', 'stale')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scenario_snapshots (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scenario_id  TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  inputs_json  JSONB NOT NULL,
  results_json JSONB NOT NULL,
  pass         INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'complete'
);

CREATE INDEX idx_scenario_snapshots_scenario ON scenario_snapshots(scenario_id, run_at DESC);

CREATE TABLE scenario_period_results (
  id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  snapshot_id            TEXT NOT NULL REFERENCES scenario_snapshots(id) ON DELETE CASCADE,
  period_date            DATE NOT NULL,
  period_type            TEXT NOT NULL CHECK (period_type IN ('month', 'year')),
  gross_income           NUMERIC(20,2),
  total_expenses         NUMERIC(20,2),
  net_cash_pretax        NUMERIC(20,2),
  estimated_tax          NUMERIC(20,2),
  net_cash_aftertax      NUMERIC(20,2),
  total_asset_value      NUMERIC(20,2),
  total_liability_value  NUMERIC(20,2),
  net_worth              NUMERIC(20,2),
  account_balances_json  JSONB
);

CREATE INDEX idx_scenario_period_results_snapshot
  ON scenario_period_results(snapshot_id, period_date);

CREATE TABLE scenario_flags (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  snapshot_id TEXT NOT NULL REFERENCES scenario_snapshots(id) ON DELETE CASCADE,
  period_date DATE NOT NULL,
  flag_type   TEXT NOT NULL,
  description TEXT,
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX idx_scenario_flags_snapshot ON scenario_flags(snapshot_id, period_date);

CREATE TABLE allocation_decisions (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  snapshot_id         TEXT NOT NULL REFERENCES scenario_snapshots(id) ON DELETE CASCADE,
  period_date         DATE NOT NULL,
  decision_type       TEXT NOT NULL,
  pass1_action        TEXT,
  pass2_action        TEXT,
  net_worth_impact    NUMERIC(20,2),
  rationale           TEXT,
  flagged_for_review  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE scenario_jobs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scenario_id     TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  error_message   TEXT,
  worker_instance TEXT,
  progress_note   TEXT
);

CREATE INDEX idx_scenario_jobs_scenario ON scenario_jobs(scenario_id, queued_at DESC);
