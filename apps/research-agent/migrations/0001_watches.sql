-- 0001_watches.sql
-- Page-monitoring: watches + watch_hits tables.
--
-- Apply with:
--   wrangler d1 execute research-agent-db --file=migrations/0001_watches.sql --remote
--
-- A "watch" is a saved instruction to periodically fetch a URL and look for a
-- change. When the match condition is met (or a new match since last_matched_at),
-- a watch_hit row is recorded and a notification email is sent.
--
-- interval_minutes: must be one of 5, 15, 30, 60, 240, 1440 (5m, 15m, 30m, 1h, 4h, 1d).
-- match_type:
--   contains     — match fires when match_value appears in fetched text
--   not_contains — match fires when match_value is absent (e.g. "Sold Out" disappears)
--   regex        — match fires when regex matches fetched text
--   hash         — match fires when page content hash changes
-- notify_mode:
--   once   — only notify the first time a match is seen (default; resets when page stops matching)
--   every  — notify every check that matches

CREATE TABLE IF NOT EXISTS watches (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  interval_minutes  INTEGER NOT NULL,
  match_type        TEXT NOT NULL CHECK (match_type IN ('contains','not_contains','regex','hash')),
  match_value       TEXT,
  notify_email      TEXT NOT NULL,
  notify_mode       TEXT NOT NULL DEFAULT 'once' CHECK (notify_mode IN ('once','every')),
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_checked_at   TEXT,
  last_hash         TEXT,
  last_matched_at   TEXT,
  last_notified_at  TEXT,
  last_error        TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watches_enabled_interval ON watches(enabled, interval_minutes);
CREATE INDEX IF NOT EXISTS idx_watches_last_checked ON watches(last_checked_at);

CREATE TABLE IF NOT EXISTS watch_hits (
  id          TEXT PRIMARY KEY,
  watch_id    TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  matched_at  TEXT NOT NULL,
  snippet     TEXT,
  page_hash   TEXT,
  notified    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_watch_hits_watch_id ON watch_hits(watch_id, matched_at DESC);
