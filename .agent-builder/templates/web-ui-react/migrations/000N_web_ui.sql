-- Append to a new numbered migration file in apps/{{AGENT_ID}}/migrations/.
-- WebSessions is REQUIRED. Drop the second block if your agent has no
-- concept of period briefs.

CREATE TABLE IF NOT EXISTS WebSessions (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  expiresAt   TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_websessions_sessionId ON WebSessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_websessions_expiresAt        ON WebSessions(expiresAt);

-- Optional: add domain tables for your SPA below.
