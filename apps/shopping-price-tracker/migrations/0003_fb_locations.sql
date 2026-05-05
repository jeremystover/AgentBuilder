-- Per-item Facebook Marketplace location overrides.
--
-- NULL means "use FB_DEFAULT_LOCATIONS from env"; a JSON array<string> of
-- city names (e.g. ["vergennes"]) restricts the FB search to those cities.
-- Only product items use this column.

ALTER TABLE tracked_items ADD COLUMN fb_locations TEXT;
