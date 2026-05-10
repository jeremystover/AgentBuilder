-- Gmail OAuth enrollments: one row per user, stores the refresh token
-- used by the nightly Amazon email sync.
CREATE TABLE IF NOT EXISTS gmail_enrollments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email_address TEXT,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gmail_enrollments_user
  ON gmail_enrollments(user_id);

-- Dedup table: one row per Gmail message we've already processed.
-- Prevents re-fetching and re-importing emails across nightly runs.
CREATE TABLE IF NOT EXISTS amazon_email_processed (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL UNIQUE,
  order_id TEXT,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_amazon_email_processed_user
  ON amazon_email_processed(user_id);
