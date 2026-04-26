-- 0005_lab_notes.sql
-- Notes — polymorphic capture surface for The Lab.
--
-- A note is a free-form scrap of text. It can be:
--   - Standalone (target_kind / target_id NULL) — created from chat or
--     "+ New note", lives in its own list.
--   - Attached to an idea (target_kind = 'idea').
--   - Attached to an article (target_kind = 'article').
--
-- source_session_id records which chat session a "Save as note" came
-- from, so a note's provenance survives even if the original session
-- gets archived/deleted later. linked_article_ids mirrors the same
-- field on ideas and is used when a note synthesizes across articles
-- (typically pinned at the time of capture).

CREATE TABLE IF NOT EXISTS notes (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  tags                TEXT NOT NULL DEFAULT '[]',
  target_kind         TEXT,
  target_id           TEXT,
  source_session_id   TEXT,
  linked_article_ids  TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (target_kind IS NULL OR target_kind IN ('idea', 'article'))
);

CREATE INDEX IF NOT EXISTS idx_notes_target      ON notes(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at  ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_session     ON notes(source_session_id);
