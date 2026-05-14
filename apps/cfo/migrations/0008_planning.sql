-- Module 3 (Planning) — evolve the Phase 3 stub schema and add the rest.
--
-- Phase 3 created skeletal `plans`, `plan_category_amounts`, and
-- `plan_settings` (a singleton for the active plan id). Phase 4 moves
-- the active-plan flag onto the `plans` row itself, adds override
-- semantics to category amounts, and introduces time-based changes +
-- one-time items.

-- ── plans: add is_active + foundation/parent CHECK ───────────────────────
ALTER TABLE plans
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE plans
  ADD CONSTRAINT foundation_has_no_parent CHECK (
    type = 'modification' OR parent_plan_id IS NULL
  );

-- Drop the singleton table; active flag lives on plans now.
DROP TABLE plan_settings;

-- Enforce single active plan at the database level: only one row may
-- carry is_active = true at any time.
CREATE UNIQUE INDEX idx_plans_single_active
  ON plans ((is_active)) WHERE is_active;

-- ── plan_category_amounts: relax amount, add override fields ─────────────
ALTER TABLE plan_category_amounts
  ALTER COLUMN amount DROP NOT NULL,
  ALTER COLUMN amount DROP DEFAULT;

ALTER TABLE plan_category_amounts
  ADD COLUMN override_type   TEXT NOT NULL DEFAULT 'inherited'
                              CHECK (override_type IN ('inherited', 'delta', 'fixed')),
  ADD COLUMN base_rate_pct   NUMERIC(6,4),
  ADD COLUMN base_rate_start DATE,
  ADD COLUMN created_at      TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── plan_category_changes: scheduled discrete deltas over time ──────────
CREATE TABLE plan_category_changes (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_category_amount_id TEXT NOT NULL REFERENCES plan_category_amounts(id) ON DELETE CASCADE,
  effective_date          DATE NOT NULL,
  delta_amount            NUMERIC(12,2) NOT NULL,
  notes                   TEXT
);

CREATE INDEX idx_plan_category_changes_amount
  ON plan_category_changes(plan_category_amount_id, effective_date);

-- ── plan_one_time_items: dated expenses + income events ──────────────────
CREATE TABLE plan_one_time_items (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  item_date   DATE NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  category_id TEXT REFERENCES categories(id),
  notes       TEXT
);

CREATE INDEX idx_plan_one_time_items_plan ON plan_one_time_items(plan_id, item_date);
