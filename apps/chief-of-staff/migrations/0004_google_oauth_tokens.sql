-- 0004_google_oauth_tokens.sql
-- Stores Google OAuth2 refresh tokens in D1 so they can be updated at
-- runtime via the browser-based /internal/google-reauth flow — no Node.js
-- or local source files required.
--
-- D1 takes precedence over the GOOGLE_OAUTH_*_REFRESH_TOKEN env var secrets.
-- The env var secrets remain as a fallback for initial setup and deployments
-- that haven't run this migration yet.
--
-- Apply with:
--   wrangler d1 execute chief-of-staff-db --file=migrations/0004_google_oauth_tokens.sql

CREATE TABLE IF NOT EXISTS google_oauth_tokens (
  account      TEXT PRIMARY KEY,   -- e.g. "personal", "work"
  refresh_token TEXT NOT NULL,
  updated_at   TEXT NOT NULL        -- ISO 8601 timestamp
);
