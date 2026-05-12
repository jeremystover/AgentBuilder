-- Migration 0018: Etsy receipt email enrichment.
--
-- Scans Gmail for Etsy purchase receipt emails (transaction@etsy.com),
-- extracts item names, shop, and total, then matches to the corresponding
-- ETSY credit card transaction. Item names are passed to the AI classifier.

PRAGMA defer_foreign_keys = ON;

ALTER TABLE email_sync_state ADD COLUMN etsy_last_synced_at TEXT;

CREATE TABLE IF NOT EXISTS etsy_email_matches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  order_id TEXT,
  items_json TEXT NOT NULL DEFAULT '[]',  -- JSON array of {name, price}
  shop_name TEXT,
  total_amount REAL NOT NULL,
  receipt_date TEXT,
  gmail_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS etsy_email_processed (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL UNIQUE,
  order_id TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_etsy_matches_tx
  ON etsy_email_matches(transaction_id);

CREATE INDEX IF NOT EXISTS idx_etsy_email_processed_msg
  ON etsy_email_processed(gmail_message_id);

PRAGMA defer_foreign_keys = OFF;
