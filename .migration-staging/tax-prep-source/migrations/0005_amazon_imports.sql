PRAGMA defer_foreign_keys = ON;

CREATE TABLE IF NOT EXISTS imports_new (
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

CREATE TABLE IF NOT EXISTS amazon_orders (
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

CREATE TABLE IF NOT EXISTS amazon_transaction_matches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amazon_order_id TEXT NOT NULL UNIQUE REFERENCES amazon_orders(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  match_score REAL NOT NULL,
  match_method TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_amazon_orders_user_dates
  ON amazon_orders(user_id, order_date, shipment_date);

CREATE INDEX IF NOT EXISTS idx_amazon_orders_import
  ON amazon_orders(import_id);

CREATE INDEX IF NOT EXISTS idx_amazon_matches_tx
  ON amazon_transaction_matches(transaction_id);

UPDATE business_entities
SET name = 'Whitford House'
WHERE slug = 'airbnb';

PRAGMA defer_foreign_keys = OFF;
