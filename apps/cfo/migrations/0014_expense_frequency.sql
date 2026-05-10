-- Expense frequency types: one-time + per-transaction override.
--
-- Two changes:
--   1) Allow `one_time` as a budget_targets.cadence value so a category
--      like 'kitchen_remodel' or 'vacation_2026' can be tracked as a fixed
--      envelope and excluded from anticipated-monthly forecasts.
--   2) Add classifications.expense_type so an individual transaction can
--      be flagged 'one_time' even when its category is normally recurring
--      (e.g. a one-off appliance purchase inside 'home_repairs').
--
-- SQLite can't ALTER an existing CHECK constraint, so the budget_targets
-- table is rebuilt. Existing rows are preserved as-is.

PRAGMA foreign_keys = OFF;

CREATE TABLE budget_targets_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_slug   TEXT NOT NULL,
  cadence         TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'annual', 'one_time')),
  amount          REAL NOT NULL,
  effective_from  TEXT NOT NULL DEFAULT (date('now')),
  effective_to    TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO budget_targets_new
  (id, user_id, category_slug, cadence, amount, effective_from, effective_to, notes, created_at)
SELECT id, user_id, category_slug, cadence, amount, effective_from, effective_to, notes, created_at
FROM budget_targets;

DROP TABLE budget_targets;
ALTER TABLE budget_targets_new RENAME TO budget_targets;

CREATE INDEX IF NOT EXISTS idx_budget_targets_user_cat
  ON budget_targets(user_id, category_slug);
CREATE INDEX IF NOT EXISTS idx_budget_targets_effective
  ON budget_targets(user_id, effective_from, effective_to);

PRAGMA foreign_keys = ON;

-- NULL = recurring (default); 'one_time' = exclude from forecast averages.
ALTER TABLE classifications ADD COLUMN expense_type TEXT
  CHECK (expense_type IS NULL OR expense_type IN ('recurring', 'one_time'));

ALTER TABLE classification_history ADD COLUMN expense_type TEXT;
