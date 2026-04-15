-- Add geographic coordinates to properties and a reviews table.
-- Reviews attach at the property level (one "The Whitford House"
-- review applies to every unit on the property), which matches how
-- guests typically write them.  JSON-LD on every unit detail page
-- pulls the aggregate rating and recent reviews from here.
--
-- Apply with:
--   wrangler d1 execute booking_sync --file=./migrations/0003_location_reviews.sql

ALTER TABLE properties ADD COLUMN latitude  REAL;
ALTER TABLE properties ADD COLUMN longitude REAL;
ALTER TABLE properties ADD COLUMN country   TEXT DEFAULT 'US';
ALTER TABLE properties ADD COLUMN locality  TEXT;
ALTER TABLE properties ADD COLUMN region    TEXT;
ALTER TABLE properties ADD COLUMN postal_code TEXT;

CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  booking_id      INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  author_name     TEXT NOT NULL,
  rating          INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title           TEXT,
  body            TEXT,
  source          TEXT NOT NULL DEFAULT 'direct',  -- direct|airbnb|vrbo|booking|google|manual
  external_id     TEXT,
  published       INTEGER NOT NULL DEFAULT 1,
  stay_date       TEXT,   -- YYYY-MM-DD
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_property ON reviews(property_id, published);
CREATE INDEX IF NOT EXISTS idx_reviews_source   ON reviews(source, external_id);
