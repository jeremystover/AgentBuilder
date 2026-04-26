-- mark-migrations-applied.sql — one-time bootstrap for the prod D1.
--
-- Run this ONCE against an existing chief-of-staff-db that was set up via
-- the old `wrangler d1 execute --file=migrations/0001_…` pattern, BEFORE
-- the GitHub Action's `wrangler d1 migrations apply --remote` step runs
-- for the first time.
--
-- Why: wrangler's auto-migrate uses a `d1_migrations` tracking table to
-- know what has already run. On a database that was bootstrapped manually,
-- that table doesn't exist yet, so the next auto-migrate would re-run
-- every file from 0001 onward — and 0002_import_data.sql is plain INSERT
-- (not INSERT OR IGNORE), so the 148 bootstrap rows would duplicate.
--
-- This script creates the tracking table (using the same shape wrangler
-- itself uses) and marks 0001-0005 as already applied. The GitHub Action
-- will then only run 0006_notes.sql and any future migrations.
--
-- Apply (from apps/chief-of-staff/):
--
--   wrangler d1 execute chief-of-staff-db --remote \
--     --file=scripts/mark-migrations-applied.sql
--
-- Verify:
--
--   wrangler d1 execute chief-of-staff-db --remote \
--     --command="SELECT name, applied_at FROM d1_migrations ORDER BY id"
--
-- Safe to re-run (CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE).

CREATE TABLE IF NOT EXISTS d1_migrations(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE,
    applied_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_initial_schema.sql'),
  ('0002_import_data.sql'),
  ('0003_bluesky_likes.sql'),
  ('0004_email_filters.sql'),
  ('0005_web_ui.sql');
