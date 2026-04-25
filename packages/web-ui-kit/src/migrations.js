/**
 * web-ui-kit/migrations — D1 schema fragments every web UI needs.
 *
 * Agents include this in their own migration file (e.g.
 * migrations/0007_web_ui.sql) so the WebSessions table backing the cookie
 * auth exists. Briefs is included as a convenience for the common
 * day/week brief pattern but is opt-in — drop it if your agent doesn't
 * use briefs.
 */

export const WEB_SESSIONS_SQL = `
CREATE TABLE IF NOT EXISTS WebSessions (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  expiresAt   TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_websessions_sessionId ON WebSessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_websessions_expiresAt ON WebSessions(expiresAt);
`.trim();

export const BRIEFS_SQL = `
CREATE TABLE IF NOT EXISTS Briefs (
  _row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  briefId      TEXT DEFAULT '',
  kind         TEXT DEFAULT '',
  periodKey    TEXT DEFAULT '',
  goalsMd      TEXT DEFAULT '',
  generatedMd  TEXT DEFAULT '',
  reviewMd     TEXT DEFAULT '',
  updatedAt    TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_briefs_kind_period ON Briefs(kind, periodKey);
`.trim();
