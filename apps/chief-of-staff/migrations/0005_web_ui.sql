-- 0005_web_ui.sql
-- Tables backing the chief-of-staff web UI.
--
--   Briefs         daily/weekly editable goals + generated summaries
--   WebSessions    opaque session ids for the cookie-based password auth

CREATE TABLE IF NOT EXISTS Briefs (
  _row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  briefId      TEXT DEFAULT '',
  kind         TEXT DEFAULT '',   -- 'day' | 'week'
  periodKey    TEXT DEFAULT '',   -- ISO date (day) or 'YYYY-Www' (week)
  goalsMd      TEXT DEFAULT '',   -- user-editable markdown
  generatedMd  TEXT DEFAULT '',   -- last day-plan / week-plan output
  reviewMd     TEXT DEFAULT '',   -- last day-review / week-review output
  updatedAt    TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_kind_period ON Briefs(kind, periodKey);

CREATE TABLE IF NOT EXISTS WebSessions (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  expiresAt   TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_websessions_sessionId ON WebSessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_websessions_expiresAt ON WebSessions(expiresAt);
