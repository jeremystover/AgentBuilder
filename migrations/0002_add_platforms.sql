-- Add Hostaway, Furnished Finder, and TripAdvisor as iCal-synced
-- platforms.  Each gets an auto-created listing for every existing
-- unit so you can paste the import URL and start pulling immediately.
--
-- Apply with:
--   wrangler d1 execute booking_sync --file=./migrations/0002_add_platforms.sql

INSERT OR IGNORE INTO platforms (slug, display_name, adapter) VALUES
  ('hostaway',        'Hostaway',         'ical'),
  ('furnishedfinder', 'Furnished Finder', 'ical'),
  ('tripadvisor',     'TripAdvisor',      'ical');

INSERT OR IGNORE INTO listings (unit_id, platform_id, status, export_token)
SELECT u.id, p.id, 'active',
       lower(hex(randomblob(12))) || '-' || u.id || '-' || p.id
  FROM units u CROSS JOIN platforms p
 WHERE p.slug IN ('hostaway', 'furnishedfinder', 'tripadvisor');
