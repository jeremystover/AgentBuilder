-- Shopping Price Tracker — initial schema.
--
-- Two item kinds share the tracked_items table; flight-specific fields go
-- in flight_constraints to keep tracked_items lean for products. JSON
-- columns hold short string lists (query terms, retailers, watch URLs).

CREATE TABLE IF NOT EXISTS tracked_items (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('product', 'flight')),
  title               TEXT NOT NULL,
  description         TEXT DEFAULT '',
  model_number        TEXT DEFAULT '',
  query_strings       TEXT DEFAULT '[]',  -- JSON array<string>
  retailers           TEXT DEFAULT '[]',  -- JSON array<string>, optional retailer hint
  watch_urls          TEXT DEFAULT '[]',  -- JSON array<string>, populated by claude_discover
  target_price_cents  INTEGER,
  max_price_cents     INTEGER,
  currency            TEXT NOT NULL DEFAULT 'USD',
  notes               TEXT DEFAULT '',
  priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracked_items_status   ON tracked_items(status);
CREATE INDEX IF NOT EXISTS idx_tracked_items_priority ON tracked_items(priority, status);
CREATE INDEX IF NOT EXISTS idx_tracked_items_kind     ON tracked_items(kind, status);

CREATE TABLE IF NOT EXISTS flight_constraints (
  item_id        TEXT PRIMARY KEY REFERENCES tracked_items(id) ON DELETE CASCADE,
  origin         TEXT NOT NULL,
  destination    TEXT NOT NULL,
  depart_start   TEXT NOT NULL,    -- ISO date YYYY-MM-DD
  depart_end     TEXT NOT NULL,
  return_start   TEXT,             -- null for one-way
  return_end     TEXT,
  nonstop        INTEGER NOT NULL DEFAULT 0,
  cabin          TEXT NOT NULL DEFAULT 'economy' CHECK (cabin IN ('economy', 'premium_economy', 'business', 'first')),
  pax            INTEGER NOT NULL DEFAULT 1,
  max_stops      INTEGER
);

CREATE TABLE IF NOT EXISTS price_observations (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL REFERENCES tracked_items(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  listing_title   TEXT DEFAULT '',
  listing_url     TEXT DEFAULT '',
  price_cents     INTEGER NOT NULL,
  shipping_cents  INTEGER,
  currency        TEXT NOT NULL DEFAULT 'USD',
  in_stock        INTEGER,
  sale_flag       INTEGER NOT NULL DEFAULT 0,
  raw_json        TEXT,
  observed_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_item_time ON price_observations(item_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_observed ON price_observations(observed_at DESC);

CREATE TABLE IF NOT EXISTS digest_runs (
  id            TEXT PRIMARY KEY,
  ran_at        TEXT NOT NULL,
  item_count    INTEGER NOT NULL DEFAULT 0,
  email_status  TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'sent'|'failed'|'skipped'
  email_error   TEXT,
  summary_md    TEXT DEFAULT '',
  summary_html  TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_digest_runs_ran_at ON digest_runs(ran_at DESC);

CREATE TABLE IF NOT EXISTS digest_recipients (
  email     TEXT PRIMARY KEY,
  added_at  TEXT NOT NULL
);
