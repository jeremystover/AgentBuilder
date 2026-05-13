-- D1 schema for the Google OAuth token vault used by @agentbuilder/auth-google's
-- D1TokenVault. Apply with:
--   wrangler d1 execute cfo-tokens --remote --file=schema/d1/google-tokens.sql
-- Mirrors GOOGLE_TOKEN_VAULT_SCHEMA from packages/auth-google/src/schema.ts.

CREATE TABLE IF NOT EXISTS google_tokens (
  agent_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  access_token   TEXT NOT NULL,  -- encrypted
  refresh_token  TEXT,           -- encrypted
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (agent_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_google_tokens_user ON google_tokens(user_id);
