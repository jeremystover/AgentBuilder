CREATE TABLE IF NOT EXISTS tax_year_workflows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, tax_year)
);

CREATE TABLE IF NOT EXISTS tax_year_checklist_items (
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

ALTER TABLE imports ADD COLUMN tax_year INTEGER;

CREATE INDEX IF NOT EXISTS idx_tax_year_workflows_user_active
  ON tax_year_workflows(user_id, is_active, tax_year DESC);

CREATE INDEX IF NOT EXISTS idx_tax_year_checklist_workflow
  ON tax_year_checklist_items(tax_year_workflow_id, sort_order, label);

CREATE INDEX IF NOT EXISTS idx_imports_user_tax_year
  ON imports(user_id, tax_year, created_at DESC);
