-- Web UI schema. Append to your next migration file under
-- apps/{{AGENT_ID}}/migrations/. The WebSessions table is REQUIRED for
-- cookie auth. Briefs is optional — drop the second block if your agent
-- doesn't render day/week briefs.

CREATE TABLE IF NOT EXISTS WebSessions (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  expiresAt   TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_websessions_sessionId ON WebSessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_websessions_expiresAt ON WebSessions(expiresAt);

-- Optional: day/week briefs (used for the Today/This-Week brief editor pattern).
-- Drop if your agent has no concept of an editable period brief.
CREATE TABLE IF NOT EXISTS Briefs (
  _row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  briefId      TEXT DEFAULT '',
  kind         TEXT DEFAULT '',   -- 'day' | 'week' (or your agent's periods)
  periodKey    TEXT DEFAULT '',   -- ISO date / 'YYYY-Www' / etc.
  goalsMd      TEXT DEFAULT '',
  generatedMd  TEXT DEFAULT '',
  reviewMd     TEXT DEFAULT '',
  updatedAt    TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_kind_period ON Briefs(kind, periodKey);
