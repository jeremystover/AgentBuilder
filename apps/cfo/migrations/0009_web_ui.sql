-- Web UI session storage (cookie auth via @agentbuilder/web-ui-kit).
-- Backs the new React/Vite SPA at /. The legacy /legacy SPA still uses
-- header-auth (X-User-Id) and is unaffected by this table.
CREATE TABLE IF NOT EXISTS WebSessions (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  expiresAt   TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_websessions_sessionId ON WebSessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_websessions_expiresAt        ON WebSessions(expiresAt);
