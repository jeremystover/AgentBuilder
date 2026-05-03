-- Dashboard auth + tool-call telemetry.
-- WebSessions backs the /dashboard cookie auth (via @agentbuilder/web-ui-kit).
-- tool_calls is written to by tools that opt in (small surface for now).

CREATE TABLE IF NOT EXISTS WebSessions (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  expiresAt   TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_websessions_sessionId ON WebSessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_websessions_expiresAt ON WebSessions(expiresAt);

CREATE TABLE IF NOT EXISTS tool_calls (
  call_id     TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  tool        TEXT NOT NULL,
  status      TEXT NOT NULL,
  duration_ms INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_tool
  ON tool_calls(agent_id, tool);
CREATE INDEX IF NOT EXISTS idx_tool_calls_created
  ON tool_calls(created_at DESC);
