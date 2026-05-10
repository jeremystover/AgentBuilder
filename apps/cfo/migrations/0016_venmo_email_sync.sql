-- Migration 0016: switch Gmail auth to fleet-wide env vars and add Venmo
-- email enrichment support.
--
-- gmail_enrollments (from 0015) stored the OAuth refresh token in D1. We no
-- longer need that — the refresh token lives in GOOGLE_OAUTH_REFRESH_TOKEN
-- (same secret the chief-of-staff uses). Drop the table and replace it with a
-- lightweight sync-state tracker that only records the last-sync timestamp.

PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS gmail_enrollments;

CREATE TABLE IF NOT EXISTS email_sync_state (
  user_id TEXT PRIMARY KEY,
  amazon_last_synced_at TEXT,
  venmo_last_synced_at TEXT
);

-- Venmo email enrichment: counterparty + memo matched to a bank transaction.
CREATE TABLE IF NOT EXISTS venmo_email_matches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  counterparty TEXT,
  memo TEXT,
  direction TEXT CHECK (direction IN ('received', 'sent', 'charged')),
  venmo_amount REAL,
  venmo_date TEXT,
  gmail_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dedup: one row per processed Gmail message so reruns are cheap.
CREATE TABLE IF NOT EXISTS venmo_email_processed (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL UNIQUE,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_venmo_matches_tx
  ON venmo_email_matches(transaction_id);

CREATE INDEX IF NOT EXISTS idx_venmo_email_processed_msg
  ON venmo_email_processed(gmail_message_id);

PRAGMA defer_foreign_keys = OFF;
