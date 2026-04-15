-- Booking Sync Manager schema
-- Designed for Cloudflare D1 (SQLite)
--
-- Core idea: "units" are the physical rentable things.  An atomic_unit is a
-- room / standalone property that cannot overlap itself.  A composite_unit
-- groups atomics (e.g. "Main House 4BR" = {A,B,C,D}).  A booking on *any*
-- unit marks its atomic members unavailable, and therefore blocks every
-- composite that contains any of those atomics.  This is the rule that lets
-- us sell the same physical space on multiple listings without double
-- booking.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS properties (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  address         TEXT,
  locality        TEXT,            -- city / town
  region          TEXT,            -- state / province
  postal_code     TEXT,
  country         TEXT DEFAULT 'US',
  latitude        REAL,            -- decimal degrees
  longitude       REAL,            -- decimal degrees
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  description     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS units (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,        -- "Guest House", "Main House 4BR", "Room A"
  kind            TEXT NOT NULL CHECK(kind IN ('atomic','composite')),
  sleeps          INTEGER,
  bedrooms        INTEGER,
  bathrooms       REAL,
  base_price      REAL,
  cleaning_fee    REAL,
  min_nights      INTEGER DEFAULT 1,
  description     TEXT,
  amenities_json  TEXT,                 -- JSON array
  house_rules     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_units_property ON units(property_id);

-- Links composite units to the atomic units they contain.
CREATE TABLE IF NOT EXISTS unit_components (
  composite_unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  atomic_unit_id    INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  PRIMARY KEY (composite_unit_id, atomic_unit_id)
);

-- Registered external platforms (Airbnb, VRBO, Booking.com, direct, etc.)
CREATE TABLE IF NOT EXISTS platforms (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,  -- airbnb, vrbo, booking, direct
  display_name    TEXT NOT NULL,
  adapter         TEXT NOT NULL DEFAULT 'ical', -- 'ical' | 'api' | 'direct'
  api_credentials TEXT                   -- JSON blob (encrypted at rest ideally)
);

INSERT OR IGNORE INTO platforms (slug, display_name, adapter) VALUES
  ('airbnb',         'Airbnb',          'ical'),
  ('vrbo',           'VRBO',            'ical'),
  ('booking',        'Booking.com',     'ical'),
  ('hostaway',       'Hostaway',        'ical'),
  ('furnishedfinder','Furnished Finder','ical'),
  ('tripadvisor',    'TripAdvisor',     'ical'),
  ('direct',         'Direct',          'direct');

-- A listing is one (unit × platform) pair.  Each listing gets its own
-- iCal import URL (the platform's feed we pull) and export token (the
-- feed we serve back to the platform).
CREATE TABLE IF NOT EXISTS listings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  platform_id     INTEGER NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  external_id     TEXT,                  -- listing id at the platform
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'active', -- active|paused|archived
  ical_import_url TEXT,                  -- we pull FROM here
  export_token    TEXT NOT NULL UNIQUE,  -- we serve at /ical/<token>.ics
  last_pulled_at  TEXT,
  last_error      TEXT,
  overrides_json  TEXT,                  -- per-listing content overrides
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (unit_id, platform_id)
);
CREATE INDEX IF NOT EXISTS idx_listings_unit ON listings(unit_id);

-- Bookings: pulled from a listing OR created directly.
CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  listing_id      INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  source_platform TEXT NOT NULL,         -- airbnb | vrbo | booking | direct | manual
  external_uid    TEXT,                  -- UID from the source iCal / API
  status          TEXT NOT NULL DEFAULT 'confirmed', -- hold|confirmed|cancelled
  start_date      TEXT NOT NULL,         -- YYYY-MM-DD, check-in
  end_date        TEXT NOT NULL,         -- YYYY-MM-DD, check-out (exclusive)
  guest_name      TEXT,
  guest_email     TEXT,
  guest_phone     TEXT,
  adults          INTEGER,
  children        INTEGER,
  total_amount    REAL,
  currency        TEXT,
  notes           TEXT,
  raw_json        TEXT,
  -- Payment / hold tracking (see migrations/0001_payments.sql)
  hold_expires_at    TEXT,
  payment_provider   TEXT,                -- 'stripe' | 'square'
  payment_session_id TEXT,                -- Stripe checkout session id / Square payment link id
  payment_intent_id  TEXT,                -- Stripe payment_intent id / Square payment id
  payment_status     TEXT,                -- 'pending' | 'paid' | 'failed' | 'refunded'
  amount_cents       INTEGER,
  nights             INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_platform, external_uid)
);
CREATE INDEX IF NOT EXISTS idx_bookings_unit ON bookings(unit_id);
CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_bookings_payment_session ON bookings(payment_session_id);
CREATE INDEX IF NOT EXISTS idx_bookings_hold_expires ON bookings(hold_expires_at);

-- Photos per unit, stored in R2.
CREATE TABLE IF NOT EXISTS photos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  r2_key          TEXT NOT NULL,
  caption         TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  width           INTEGER,
  height          INTEGER,
  content_type    TEXT,
  size_bytes      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_unit ON photos(unit_id, sort_order);

-- Pricing / availability overrides per unit per date.
CREATE TABLE IF NOT EXISTS rate_overrides (
  unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  price           REAL,
  min_nights      INTEGER,
  blocked         INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  PRIMARY KEY (unit_id, date)
);

-- Sync log for debugging / UI.
CREATE TABLE IF NOT EXISTS sync_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id      INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL, -- 'pull' | 'push'
  status          TEXT NOT NULL, -- 'ok' | 'error'
  message         TEXT,
  bookings_added  INTEGER DEFAULT 0,
  bookings_updated INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_log_listing ON sync_log(listing_id, created_at);

-- Guest reviews.  Attach at the property level so every unit on the
-- property shares the aggregate rating displayed in search results.
CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id     INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  booking_id      INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  author_name     TEXT NOT NULL,
  rating          INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title           TEXT,
  body            TEXT,
  source          TEXT NOT NULL DEFAULT 'direct', -- direct|airbnb|vrbo|booking|google|manual
  external_id     TEXT,
  published       INTEGER NOT NULL DEFAULT 1,
  stay_date       TEXT,            -- YYYY-MM-DD of the stay
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_property ON reviews(property_id, published);
CREATE INDEX IF NOT EXISTS idx_reviews_source   ON reviews(source, external_id);
