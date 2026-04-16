-- Migration 001: expand listing_node and listing_snapshot for cross-platform import & audit
--
-- Apply with:
--   wrangler d1 execute guest-booking-db --file=apps/guest-booking/src/db/migrations/001-expand-snapshots.sql

-- Add property_id to group same-property listings across platforms.
ALTER TABLE listing_node ADD COLUMN property_id TEXT;
CREATE INDEX IF NOT EXISTS idx_listing_node_property ON listing_node(property_id);

-- Expand listing_snapshot with fields needed for full cross-platform audit.
ALTER TABLE listing_snapshot ADD COLUMN cleaning_fee_cents INTEGER;
ALTER TABLE listing_snapshot ADD COLUMN security_deposit_cents INTEGER;
ALTER TABLE listing_snapshot ADD COLUMN weekly_discount_pct REAL;
ALTER TABLE listing_snapshot ADD COLUMN monthly_discount_pct REAL;
ALTER TABLE listing_snapshot ADD COLUMN max_nights INTEGER;
ALTER TABLE listing_snapshot ADD COLUMN cancellation_policy TEXT;
ALTER TABLE listing_snapshot ADD COLUMN instant_book INTEGER;
ALTER TABLE listing_snapshot ADD COLUMN property_type TEXT;
ALTER TABLE listing_snapshot ADD COLUMN bedrooms INTEGER;
ALTER TABLE listing_snapshot ADD COLUMN bathrooms REAL;
ALTER TABLE listing_snapshot ADD COLUMN beds INTEGER;
ALTER TABLE listing_snapshot ADD COLUMN max_guests INTEGER;
ALTER TABLE listing_snapshot ADD COLUMN check_in_time TEXT;
ALTER TABLE listing_snapshot ADD COLUMN check_out_time TEXT;
ALTER TABLE listing_snapshot ADD COLUMN house_rules TEXT;
ALTER TABLE listing_snapshot ADD COLUMN pet_policy TEXT;
ALTER TABLE listing_snapshot ADD COLUMN amenities TEXT;
