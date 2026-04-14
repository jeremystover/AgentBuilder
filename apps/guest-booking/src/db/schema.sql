-- guest-booking D1 schema
--
-- Apply with:
--   wrangler d1 execute guest-booking-db --file=apps/guest-booking/src/db/schema.sql
--
-- The inventory graph is the key differentiator: farm-house topology
-- (4BR / 3BR-with-host / individual rooms) is encoded as graph data,
-- not hardcoded. Reconfiguring the property = editing rows.

-- Inventory graph: nodes
CREATE TABLE IF NOT EXISTS listing_node (
  id TEXT PRIMARY KEY,          -- internal uuid
  guesty_id TEXT,
  platform TEXT NOT NULL,       -- 'airbnb' | 'vrbo' | 'booking_com' | 'guesty'
  external_listing_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listing_node_platform ON listing_node(platform);
CREATE INDEX IF NOT EXISTS idx_listing_node_guesty ON listing_node(guesty_id);

-- Inventory graph: edges
--   'contains'        booking to_node blocks from_node  (whole-house blocks rooms)
--   'conflicts_with'  symmetric — booking either blocks the other
CREATE TABLE IF NOT EXISTS listing_edge (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES listing_node(id),
  to_node_id TEXT NOT NULL REFERENCES listing_node(id),
  edge_type TEXT NOT NULL CHECK(edge_type IN ('contains','conflicts_with')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listing_edge_from ON listing_edge(from_node_id);
CREATE INDEX IF NOT EXISTS idx_listing_edge_to ON listing_edge(to_node_id);

-- Per-platform metadata snapshots used by the consistency auditor.
-- One row per audit run per listing; the diff engine compares rows
-- where `listing_node_id` belongs to the same property-logical-unit.
CREATE TABLE IF NOT EXISTS listing_snapshot (
  id TEXT PRIMARY KEY,
  listing_node_id TEXT NOT NULL REFERENCES listing_node(id),
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  price_cents INTEGER,
  min_nights INTEGER,
  title TEXT,
  description TEXT,
  photo_urls TEXT               -- JSON array
);
CREATE INDEX IF NOT EXISTS idx_listing_snapshot_node ON listing_snapshot(listing_node_id, snapshot_at);

-- Booking events log (raw source of truth; one row per inbound event).
CREATE TABLE IF NOT EXISTS booking_event (
  id TEXT PRIMARY KEY,
  listing_node_id TEXT NOT NULL REFERENCES listing_node(id),
  platform TEXT NOT NULL,
  external_booking_id TEXT NOT NULL,
  check_in TEXT NOT NULL,       -- ISO date
  check_out TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('booked','cancelled','modified')),
  received_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_booking_event_dates ON booking_event(check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_booking_event_external ON booking_event(platform, external_booking_id);

-- Persisted audit report history (so the operator UI can browse past runs).
CREATE TABLE IF NOT EXISTS audit_report (
  id TEXT PRIMARY KEY,
  run_at TEXT DEFAULT (datetime('now')),
  divergence_count INTEGER NOT NULL,
  report_json TEXT NOT NULL
);
