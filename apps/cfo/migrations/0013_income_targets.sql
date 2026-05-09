-- Income targets per entity (versioned, same pattern as budget_targets).
-- Stores monthly/weekly/annual income goals for each business entity.

CREATE TABLE income_targets (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  entity         TEXT NOT NULL CHECK (entity IN ('elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal')),
  cadence        TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'annual')),
  amount         REAL NOT NULL CHECK (amount >= 0),
  effective_from TEXT NOT NULL DEFAULT (date('now')),
  effective_to   TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX income_targets_user_entity ON income_targets(user_id, entity);
