-- AI-5: notes + tasks captured from chat replies.
--
-- Single table, polymorphic on `kind`:
--   note  → user-saved snippet, no status workflow
--   task  → has status (open/done) and shows up in a follow-up filter
--
-- source_chat_message_id is the assistant turn id from the SPA's
-- useChat. Since the chat doesn't yet persist message ids server-side
-- (it's a new-conversation-each-turn surface today), this is a soft
-- reference — useful for "what reply did this come from" if we ever
-- add chat history persistence, but not enforced.

CREATE TABLE IF NOT EXISTS cfo_notes (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL CHECK (kind IN ('note','task')),
  title                    TEXT NOT NULL,
  body                     TEXT NOT NULL DEFAULT '',
  status                   TEXT NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open','done')),
  tax_year                 INTEGER,
  source_chat_message_id   TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cfo_notes_user_kind   ON cfo_notes(user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cfo_notes_user_status ON cfo_notes(user_id, status);
