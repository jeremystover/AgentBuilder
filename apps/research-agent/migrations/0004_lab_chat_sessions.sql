-- 0004_lab_chat_sessions.sql
-- Persistent chat sessions for The Lab (claude.ai-style sidebar).
--
-- chat_sessions     one row per conversation. title is auto-generated
--                   after the first reply via a small Claude call;
--                   tags/notes are user-managed; pinned_article_ids and
--                   scope persist what the user had set when they last
--                   sent a message so resuming feels seamless.
-- chat_messages     append-only per-session log. content is the JSON-
--                   stringified Anthropic ChatMessage shape (string OR
--                   ContentBlock[] when tool_use/tool_result are
--                   involved) so the model always sees a faithful
--                   replay on the next turn.

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL DEFAULT 'New session',
  tags                TEXT NOT NULL DEFAULT '[]',
  notes               TEXT NOT NULL DEFAULT '',
  scope               TEXT NOT NULL DEFAULT 'full_corpus'
                        CHECK(scope IN ('selected', 'digest', 'full_corpus')),
  pinned_article_ids  TEXT NOT NULL DEFAULT '[]',
  archived_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at ON chat_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived   ON chat_sessions(archived_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
