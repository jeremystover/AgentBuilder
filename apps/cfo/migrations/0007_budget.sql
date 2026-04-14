-- Budget subsystem — user-owned categories + targets with a cadence.
--
-- budget_categories.slug is what lines up with classifications.category_budget.
-- We don't FK the classifications table to this one because classifications
-- pre-date the budget feature and may contain legacy slugs; the status
-- calculator just groups by category_budget and joins here for display.

CREATE TABLE IF NOT EXISTS budget_categories (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  parent_slug  TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_budget_categories_user
  ON budget_categories(user_id);

CREATE TABLE IF NOT EXISTS budget_targets (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_slug   TEXT NOT NULL,
  cadence         TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'annual')),
  amount          REAL NOT NULL,
  effective_from  TEXT NOT NULL DEFAULT (date('now')),
  effective_to    TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_targets_user_cat
  ON budget_targets(user_id, category_slug);

CREATE INDEX IF NOT EXISTS idx_budget_targets_effective
  ON budget_targets(user_id, effective_from, effective_to);
