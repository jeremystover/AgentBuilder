-- Module 4 (Spending) — plan-vs-actual reporting.
--
-- Minimal `plans` / `plan_category_amounts` schema is included here so the
-- Spending engine has something to query. Phase 4 (Planning) will build the
-- editor UI on top and may add `plan_category_changes` / one-time items.

CREATE TABLE plans (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'foundation'
                CHECK (type IN ('foundation', 'modification')),
  parent_plan_id TEXT REFERENCES plans(id),
  start_date    DATE,
  end_date      DATE,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'archived')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plan_category_amounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  category_id   TEXT NOT NULL REFERENCES categories(id),
  amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  period_type   TEXT NOT NULL DEFAULT 'monthly'
                CHECK (period_type IN ('monthly', 'annual')),
  UNIQUE (plan_id, category_id)
);

CREATE INDEX idx_plan_category_amounts_plan ON plan_category_amounts(plan_id);

-- Singleton row holding the currently-active comparison plan id.
CREATE TABLE plan_settings (
  id              TEXT PRIMARY KEY DEFAULT 'singleton',
  active_plan_id  TEXT REFERENCES plans(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO plan_settings (id, active_plan_id) VALUES ('singleton', NULL);

-- =============================================
-- SPENDING module additions
-- =============================================

CREATE TABLE category_groups (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE category_group_members (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  group_id    TEXT NOT NULL REFERENCES category_groups(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  UNIQUE (group_id, category_id)
);

CREATE TABLE spending_views (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name            TEXT NOT NULL,
  plan_ids        TEXT[] NOT NULL DEFAULT '{}',
  date_preset     TEXT,
  date_from       DATE,
  date_to         DATE,
  entity_ids      TEXT[] NOT NULL DEFAULT '{}',
  category_ids    TEXT[] NOT NULL DEFAULT '{}',
  group_ids       TEXT[] NOT NULL DEFAULT '{}',
  period_type     TEXT NOT NULL DEFAULT 'monthly'
                  CHECK (period_type IN ('monthly', 'annual')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
