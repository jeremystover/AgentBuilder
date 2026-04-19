-- Canva OAuth token storage.

CREATE TABLE IF NOT EXISTS canva_tokens (
  user_id        TEXT PRIMARY KEY,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  scopes         TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
