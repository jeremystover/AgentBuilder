-- 0003_lab_idea_positions.sql
-- Add per-idea mind-map node coordinates so user-arranged layouts survive
-- a page reload. Stored as JSON {x, y} (or NULL when the user hasn't
-- positioned the node yet — the SPA falls back to the auto layout).

ALTER TABLE ideas ADD COLUMN position TEXT;
