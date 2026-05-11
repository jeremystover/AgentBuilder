-- Migration 0017: Apple receipt email enrichment for APPLE.COM/BILL charges.
--
-- Scans Gmail for Apple receipt emails (no_reply@email.apple.com), extracts
-- the line items and total, then matches to the corresponding APPLE.COM/BILL
-- credit card transaction. The item list is passed to the AI classifier so it
-- knows whether the charge was iCloud storage, an app, a subscription, etc.

PRAGMA defer_foreign_keys = ON;

ALTER TABLE email_sync_state ADD COLUMN apple_last_synced_at TEXT;

-- One row per matched Apple receipt → transaction.
CREATE TABLE IF NOT EXISTS apple_email_matches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  receipt_id TEXT,
  items_json TEXT NOT NULL DEFAULT '[]',  -- JSON array of {name, price}
  total_amount REAL NOT NULL,
  receipt_date TEXT,
  gmail_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dedup: one row per processed Gmail message so reruns skip already-seen emails.
CREATE TABLE IF NOT EXISTS apple_email_processed (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL UNIQUE,
  receipt_id TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_apple_matches_tx
  ON apple_email_matches(transaction_id);

CREATE INDEX IF NOT EXISTS idx_apple_email_processed_msg
  ON apple_email_processed(gmail_message_id);

PRAGMA defer_foreign_keys = OFF;
