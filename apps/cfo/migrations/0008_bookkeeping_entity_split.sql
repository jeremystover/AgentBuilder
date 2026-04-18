-- Migration 0008: Split coaching_business into elyse_coaching + jeremy_coaching
-- and add bookkeeping infrastructure.
--
-- Entity rename: coaching_business → elyse_coaching (Elyse's Schedule C)
-- New entity:   jeremy_coaching   (Jeremy's Schedule C)
--
-- Three tables have CHECK constraints on entity that need table recreation:
--   classifications, transaction_splits, rules
-- Other tables (review_queue, classification_history) store entity as plain
-- TEXT and just need data updates.

PRAGMA foreign_keys = OFF;

-- ── 1. classifications ────────────────────────────────────────────────────────

CREATE TABLE classifications_new (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  business_entity_id TEXT REFERENCES business_entities(id),
  chart_of_account_id TEXT REFERENCES chart_of_accounts(id),
  entity TEXT CHECK (entity IN ('elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal')),
  category_tax TEXT,
  category_budget TEXT,
  confidence REAL,
  method TEXT CHECK (method IN ('rule', 'ai', 'manual', 'historical')),
  reason_codes TEXT,
  review_required INTEGER NOT NULL DEFAULT 0,
  is_locked INTEGER NOT NULL DEFAULT 0,
  classified_at TEXT NOT NULL DEFAULT (datetime('now')),
  classified_by TEXT NOT NULL DEFAULT 'system'
);

INSERT INTO classifications_new (
  id, transaction_id, business_entity_id, chart_of_account_id,
  entity, category_tax, category_budget, confidence, method,
  reason_codes, review_required, is_locked, classified_at, classified_by
)
SELECT
  id, transaction_id, business_entity_id, chart_of_account_id,
  CASE WHEN entity = 'coaching_business' THEN 'elyse_coaching' ELSE entity END,
  category_tax, category_budget, confidence, method,
  reason_codes, review_required, is_locked, classified_at, classified_by
FROM classifications;

DROP TABLE classifications;
ALTER TABLE classifications_new RENAME TO classifications;

CREATE INDEX IF NOT EXISTS idx_classifications_entity ON classifications(entity);
CREATE INDEX IF NOT EXISTS idx_classifications_review ON classifications(review_required);

-- ── 2. transaction_splits ─────────────────────────────────────────────────────

CREATE TABLE transaction_splits_new (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  business_entity_id TEXT REFERENCES business_entities(id),
  chart_of_account_id TEXT REFERENCES chart_of_accounts(id),
  entity TEXT NOT NULL CHECK (entity IN ('elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal')),
  category_tax TEXT,
  amount REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO transaction_splits_new (
  id, transaction_id, business_entity_id, chart_of_account_id,
  entity, category_tax, amount, note, created_at
)
SELECT
  id, transaction_id, business_entity_id, chart_of_account_id,
  CASE WHEN entity = 'coaching_business' THEN 'elyse_coaching' ELSE entity END,
  category_tax, amount, note, created_at
FROM transaction_splits;

DROP TABLE transaction_splits;
ALTER TABLE transaction_splits_new RENAME TO transaction_splits;

-- ── 3. rules ──────────────────────────────────────────────────────────────────

CREATE TABLE rules_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  match_field TEXT NOT NULL CHECK (match_field IN ('merchant_name', 'description', 'account_id', 'amount')),
  match_operator TEXT NOT NULL CHECK (match_operator IN ('contains', 'equals', 'starts_with', 'ends_with', 'regex')),
  match_value TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('elyse_coaching', 'jeremy_coaching', 'airbnb_activity', 'family_personal')),
  category_tax TEXT,
  category_budget TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO rules_new (
  id, user_id, name, match_field, match_operator, match_value,
  entity, category_tax, category_budget, priority, is_active, created_at
)
SELECT
  id, user_id, name, match_field, match_operator, match_value,
  CASE WHEN entity = 'coaching_business' THEN 'elyse_coaching' ELSE entity END,
  category_tax, category_budget, priority, is_active, created_at
FROM rules;

DROP TABLE rules;
ALTER TABLE rules_new RENAME TO rules;

CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(user_id, is_active, priority DESC);

-- ── 4. Update plain TEXT entity columns ───────────────────────────────────────

UPDATE review_queue SET suggested_entity = 'elyse_coaching' WHERE suggested_entity = 'coaching_business';
UPDATE classification_history SET entity = 'elyse_coaching' WHERE entity = 'coaching_business';

-- ── 5. Update business_entities ───────────────────────────────────────────────

UPDATE business_entities SET slug = 'elyse_coaching', name = 'Elyse''s Coaching' WHERE slug = 'coaching';

-- Add Jeremy's Coaching for each user that has Elyse's
INSERT INTO business_entities (id, user_id, slug, name, entity_type)
  SELECT hex(randomblob(16)), user_id, 'jeremy_coaching', 'Jeremy''s Coaching', 'schedule_c'
  FROM business_entities
  WHERE slug = 'elyse_coaching'
  ON CONFLICT(user_id, slug) DO NOTHING;

-- ── 6. Seed chart_of_accounts for Jeremy's Coaching ───────────────────────────

INSERT INTO chart_of_accounts (id, business_entity_id, code, name, form_line, category_type)
  SELECT hex(randomblob(16)), jc.id, coa.code, coa.name, coa.form_line, coa.category_type
  FROM chart_of_accounts coa
  JOIN business_entities ec ON ec.id = coa.business_entity_id AND ec.slug = 'elyse_coaching'
  JOIN business_entities jc ON jc.slug = 'jeremy_coaching' AND jc.user_id = ec.user_id
  ON CONFLICT(business_entity_id, code) DO NOTHING;

PRAGMA foreign_keys = ON;
