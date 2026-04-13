-- Add payment + hold tracking to bookings so the public booking page can
-- create a temporary hold, hand the guest off to Stripe / Square, and
-- have a webhook flip the hold to a confirmed booking.
--
-- Apply to an existing database with:
--   wrangler d1 execute booking_sync --file=./migrations/0001_payments.sql
--
-- (schema.sql has also been updated with these columns so fresh
-- databases do not need this migration.)

ALTER TABLE bookings ADD COLUMN hold_expires_at   TEXT;
ALTER TABLE bookings ADD COLUMN payment_provider  TEXT;
ALTER TABLE bookings ADD COLUMN payment_session_id TEXT;
ALTER TABLE bookings ADD COLUMN payment_intent_id TEXT;
ALTER TABLE bookings ADD COLUMN payment_status    TEXT;
ALTER TABLE bookings ADD COLUMN amount_cents      INTEGER;
ALTER TABLE bookings ADD COLUMN nights            INTEGER;

CREATE INDEX IF NOT EXISTS idx_bookings_payment_session ON bookings(payment_session_id);
CREATE INDEX IF NOT EXISTS idx_bookings_hold_expires ON bookings(hold_expires_at);
