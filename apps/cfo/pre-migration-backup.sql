PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" VALUES(1,'0001_initial_schema.sql','2026-04-14 05:47:06');
INSERT INTO "d1_migrations" VALUES(2,'0002_teller_provider_support.sql','2026-04-14 05:47:06');
INSERT INTO "d1_migrations" VALUES(3,'0003_review_queue_unclassified.sql','2026-04-14 05:47:06');
INSERT INTO "d1_migrations" VALUES(4,'0004_review_queue_details.sql','2026-04-14 05:47:07');
INSERT INTO "d1_migrations" VALUES(5,'0005_amazon_imports.sql','2026-04-14 05:47:07');
INSERT INTO "d1_migrations" VALUES(6,'0006_tax_year_workflow.sql','2026-04-14 05:47:07');
INSERT INTO "d1_migrations" VALUES(7,'0007_budget.sql','2026-04-14 05:47:07');
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE business_entities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('schedule_c', 'schedule_e', 'personal')),
  tax_year INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);
CREATE TABLE chart_of_accounts (
  id TEXT PRIMARY KEY,
  business_entity_id TEXT REFERENCES business_entities(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  form_line TEXT,
  category_type TEXT NOT NULL DEFAULT 'expense' CHECK (category_type IN ('income', 'expense')),
  is_deductible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(business_entity_id, code)
);
CREATE TABLE plaid_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  cursor TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  plaid_item_id TEXT REFERENCES plaid_items(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_account_id TEXT UNIQUE,
  name TEXT NOT NULL,
  mask TEXT,
  type TEXT,
  subtype TEXT,
  owner_tag TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, teller_enrollment_id TEXT, teller_account_id TEXT);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id),
  import_id TEXT REFERENCES imports(id),
  plaid_transaction_id TEXT UNIQUE,
  posted_date TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  merchant_name TEXT,
  description TEXT NOT NULL,
  description_clean TEXT,
  category_plaid TEXT,
  is_pending INTEGER NOT NULL DEFAULT 0,
  dedup_hash TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, teller_transaction_id TEXT);
CREATE TABLE classifications (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  business_entity_id TEXT REFERENCES business_entities(id),
  chart_of_account_id TEXT REFERENCES chart_of_accounts(id),
  entity TEXT CHECK (entity IN ('coaching_business', 'airbnb_activity', 'family_personal')),
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
CREATE TABLE classification_history (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  entity TEXT,
  category_tax TEXT,
  category_budget TEXT,
  confidence REAL,
  method TEXT,
  reason_codes TEXT,
  changed_by TEXT NOT NULL DEFAULT 'system',
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE transaction_splits (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  business_entity_id TEXT REFERENCES business_entities(id),
  chart_of_account_id TEXT REFERENCES chart_of_accounts(id),
  entity TEXT NOT NULL CHECK (entity IN ('coaching_business', 'airbnb_activity', 'family_personal')),
  category_tax TEXT,
  amount REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  match_field TEXT NOT NULL CHECK (match_field IN ('merchant_name', 'description', 'account_id', 'amount')),
  match_operator TEXT NOT NULL CHECK (match_operator IN ('contains', 'equals', 'starts_with', 'ends_with', 'regex')),
  match_value TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('coaching_business', 'airbnb_activity', 'family_personal')),
  category_tax TEXT,
  category_budget TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE filing_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  name TEXT,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE teller_enrollments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrollment_id TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS "review_queue" (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('low_confidence', 'no_match', 'conflict', 'flagged', 'unclassified')),
  suggested_entity TEXT,
  suggested_category_tax TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'skipped')),
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, details TEXT, needs_input TEXT);
CREATE TABLE IF NOT EXISTS "imports" (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('plaid', 'teller', 'csv', 'manual', 'amazon')),
  account_id TEXT REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  date_from TEXT,
  date_to TEXT,
  transactions_found INTEGER NOT NULL DEFAULT 0,
  transactions_imported INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
, tax_year INTEGER);
CREATE TABLE amazon_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  order_key TEXT NOT NULL,
  order_id TEXT,
  order_date TEXT,
  shipment_date TEXT,
  total_amount REAL NOT NULL,
  quantity_total INTEGER NOT NULL DEFAULT 1,
  product_names TEXT NOT NULL,
  seller_names TEXT,
  order_status TEXT,
  payment_instrument_type TEXT,
  ship_to TEXT,
  shipping_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE amazon_transaction_matches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amazon_order_id TEXT NOT NULL UNIQUE REFERENCES amazon_orders(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  match_score REAL NOT NULL,
  match_method TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE tax_year_workflows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, tax_year)
);
CREATE TABLE tax_year_checklist_items (
  id TEXT PRIMARY KEY,
  tax_year_workflow_id TEXT NOT NULL REFERENCES tax_year_workflows(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  label TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('teller', 'csv', 'amazon')),
  provider TEXT,
  account_name TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tax_year_workflow_id, item_key)
);
CREATE TABLE budget_categories (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  parent_slug  TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);
CREATE TABLE budget_targets (
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
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" VALUES('d1_migrations',7);
CREATE INDEX idx_transactions_user_date ON transactions(user_id, posted_date);
CREATE INDEX idx_transactions_account ON transactions(account_id);
CREATE INDEX idx_transactions_dedup ON transactions(dedup_hash);
CREATE INDEX idx_classifications_entity ON classifications(entity);
CREATE INDEX idx_classifications_review ON classifications(review_required);
CREATE INDEX idx_rules_priority ON rules(user_id, is_active, priority DESC);
CREATE INDEX idx_classification_history_tx ON classification_history(transaction_id);
CREATE UNIQUE INDEX idx_accounts_teller_account_id
  ON accounts(teller_account_id)
  WHERE teller_account_id IS NOT NULL;
CREATE UNIQUE INDEX idx_transactions_teller_transaction_id
  ON transactions(teller_transaction_id)
  WHERE teller_transaction_id IS NOT NULL;
CREATE INDEX idx_teller_enrollments_user
  ON teller_enrollments(user_id);
CREATE INDEX idx_accounts_teller_enrollment
  ON accounts(teller_enrollment_id);
CREATE INDEX idx_review_queue_status ON review_queue(user_id, status);
CREATE INDEX idx_amazon_orders_user_dates
  ON amazon_orders(user_id, order_date, shipment_date);
CREATE INDEX idx_amazon_orders_import
  ON amazon_orders(import_id);
CREATE INDEX idx_amazon_matches_tx
  ON amazon_transaction_matches(transaction_id);
CREATE INDEX idx_tax_year_workflows_user_active
  ON tax_year_workflows(user_id, is_active, tax_year DESC);
CREATE INDEX idx_tax_year_checklist_workflow
  ON tax_year_checklist_items(tax_year_workflow_id, sort_order, label);
CREATE INDEX idx_imports_user_tax_year
  ON imports(user_id, tax_year, created_at DESC);
CREATE INDEX idx_budget_categories_user
  ON budget_categories(user_id);
CREATE INDEX idx_budget_targets_user_cat
  ON budget_targets(user_id, category_slug);
CREATE INDEX idx_budget_targets_effective
  ON budget_targets(user_id, effective_from, effective_to);