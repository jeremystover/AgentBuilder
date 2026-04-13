/**
 * D1 schema for the Google token vault. Applied via `wrangler d1 migrations
 * apply` once the D1 database is created.
 */

export const GOOGLE_TOKEN_VAULT_SCHEMA = /* sql */ `
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
`;
