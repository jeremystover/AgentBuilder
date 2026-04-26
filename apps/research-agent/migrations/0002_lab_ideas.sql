-- 0002_lab_ideas.sql
-- The Lab — research-to-ideas-to-projects workbench. The `ideas` table
-- backs the right-side Ideas Board + Mind Map in the /lab SPA.
--
-- status enum: spark → developing → ready → promoted (last is terminal,
-- set when the idea has been pushed to a chief-of-staff project/task).
--
-- linked_article_ids and tags are stored as JSON arrays of strings so they
-- round-trip without a join table; we don't need to query by tag yet.
-- chat_thread captures the last few turns of the conversation that
-- spawned the idea so it stays attached as context.

CREATE TABLE IF NOT EXISTS ideas (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'spark'
                        CHECK(status IN ('spark', 'developing', 'ready', 'promoted')),
  tags                TEXT NOT NULL DEFAULT '[]',
  linked_article_ids  TEXT NOT NULL DEFAULT '[]',
  chat_thread         TEXT NOT NULL DEFAULT '[]',
  promoted_to         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ideas_status     ON ideas(status);
CREATE INDEX IF NOT EXISTS idx_ideas_updated_at ON ideas(updated_at DESC);

-- Web UI session storage (cookie auth via @agentbuilder/web-ui-kit).
-- Same shape every Lab/Console/UI agent gets via the kit.
CREATE TABLE IF NOT EXISTS WebSessions (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId   TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  expiresAt   TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_websessions_sessionId ON WebSessions(sessionId);
CREATE INDEX IF NOT EXISTS idx_websessions_expiresAt        ON WebSessions(expiresAt);
