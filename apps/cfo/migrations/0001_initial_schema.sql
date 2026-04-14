-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Business entities (coaching, airbnb, family)
CREATE TABLE IF NOT EXISTS business_entities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('schedule_c', 'schedule_e', 'personal')),
  tax_year INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);

-- Chart of accounts (Schedule C lines, family budget categories)
CREATE TABLE IF NOT EXISTS chart_of_accounts (
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

-- Plaid items (linked bank/card connections)
CREATE TABLE IF NOT EXISTS plaid_items (
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

-- Bank / credit card accounts
CREATE TABLE IF NOT EXISTS accounts (
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
);

-- Import jobs
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('plaid', 'csv', 'manual')),
  account_id TEXT REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  date_from TEXT,
  date_to TEXT,
  transactions_found INTEGER NOT NULL DEFAULT 0,
  transactions_imported INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Transactions (normalized)
CREATE TABLE IF NOT EXISTS transactions (
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
);

-- Current classifications
CREATE TABLE IF NOT EXISTS classifications (
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

-- Classification audit log
CREATE TABLE IF NOT EXISTS classification_history (
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

-- Transaction splits (one tx split across multiple entities/categories)
CREATE TABLE IF NOT EXISTS transaction_splits (
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

-- Deterministic classification rules
CREATE TABLE IF NOT EXISTS rules (
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

-- Human review queue
CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('low_confidence', 'no_match', 'conflict', 'flagged')),
  suggested_entity TEXT,
  suggested_category_tax TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'skipped')),
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Attachments (receipts stored in R2)
CREATE TABLE IF NOT EXISTS attachments (
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

-- Immutable filing snapshots
CREATE TABLE IF NOT EXISTS filing_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  name TEXT,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, posted_date);
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_dedup ON transactions(dedup_hash);
CREATE INDEX IF NOT EXISTS idx_classifications_entity ON classifications(entity);
CREATE INDEX IF NOT EXISTS idx_classifications_review ON classifications(review_required);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON review_queue(user_id, status);
CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(user_id, is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_classification_history_tx ON classification_history(transaction_id);
