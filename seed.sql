-- Seed data modelled after the described setup:
--   * Guest House  -> one standalone listing
--   * Main House   -> can be rented as 4BR (all 4 rooms), 3BR (any 3 rooms),
--                     or Room A / Room B / Room C / Room D individually.
--
-- The atomic units are Room A..D and the Guest House.  Composite units
-- reference their atomic members in unit_components so the availability
-- engine can block overlapping configurations automatically.

INSERT INTO properties (id, name, address, timezone, description) VALUES
  (1, 'Guest House', '', 'America/Los_Angeles', 'Standalone guest house listing.'),
  (2, 'Main House',  '', 'America/Los_Angeles', 'Whole-house or individual-room rental.');

-- Guest House: one atomic unit that IS the listing.
INSERT INTO units (id, property_id, name, kind, sleeps, bedrooms, bathrooms, min_nights)
VALUES (1, 1, 'Guest House', 'atomic', 2, 1, 1.0, 2);

-- Main House atomic rooms.
INSERT INTO units (id, property_id, name, kind, sleeps, bedrooms, bathrooms, min_nights) VALUES
  (10, 2, 'Main House - Room A', 'atomic', 2, 1, 1.0, 2),
  (11, 2, 'Main House - Room B', 'atomic', 2, 1, 1.0, 2),
  (12, 2, 'Main House - Room C', 'atomic', 2, 1, 1.0, 2),
  (13, 2, 'Main House - Room D', 'atomic', 2, 1, 1.0, 2);

-- Composite 4BR (whole house).
INSERT INTO units (id, property_id, name, kind, sleeps, bedrooms, bathrooms, min_nights)
VALUES (20, 2, 'Main House - Full (4BR)', 'composite', 8, 4, 3.0, 2);
INSERT INTO unit_components (composite_unit_id, atomic_unit_id) VALUES
  (20, 10), (20, 11), (20, 12), (20, 13);

-- Composite 3BR (sold as A+B+C; extra bedroom D is closed off).
INSERT INTO units (id, property_id, name, kind, sleeps, bedrooms, bathrooms, min_nights)
VALUES (21, 2, 'Main House - 3BR', 'composite', 6, 3, 2.0, 2);
INSERT INTO unit_components (composite_unit_id, atomic_unit_id) VALUES
  (21, 10), (21, 11), (21, 12);

-- Seed one listing per unit on each platform with empty iCal import URLs.
-- export_token is a random string used to serve our outgoing iCal feed.
INSERT INTO listings (unit_id, platform_id, status, export_token)
SELECT u.id, p.id, 'active',
       lower(hex(randomblob(12))) || '-' || u.id || '-' || p.id
FROM units u CROSS JOIN platforms p
WHERE p.slug IN ('airbnb','vrbo','booking','direct','hostaway','furnishedfinder','tripadvisor');
