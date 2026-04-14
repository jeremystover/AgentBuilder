-- Teller enrollments (linked bank/card connections)
CREATE TABLE IF NOT EXISTS teller_enrollments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrollment_id TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add Teller account + transaction identifiers alongside existing Plaid fields.
ALTER TABLE accounts ADD COLUMN teller_enrollment_id TEXT;
ALTER TABLE accounts ADD COLUMN teller_account_id TEXT;

ALTER TABLE transactions ADD COLUMN teller_transaction_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_teller_account_id
  ON accounts(teller_account_id)
  WHERE teller_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_teller_transaction_id
  ON transactions(teller_transaction_id)
  WHERE teller_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_teller_enrollments_user
  ON teller_enrollments(user_id);

CREATE INDEX IF NOT EXISTS idx_accounts_teller_enrollment
  ON accounts(teller_enrollment_id);

-- Expand imports.source to allow Teller sync jobs while preserving existing data.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS imports_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('plaid', 'teller', 'csv', 'manual')),
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

INSERT INTO imports_new (
  id, user_id, source, account_id, status, date_from, date_to,
  transactions_found, transactions_imported, error_message, created_at, completed_at
)
SELECT
  id, user_id, source, account_id, status, date_from, date_to,
  transactions_found, transactions_imported, error_message, created_at, completed_at
FROM imports;

DROP TABLE imports;
ALTER TABLE imports_new RENAME TO imports;

PRAGMA defer_foreign_keys = OFF;
