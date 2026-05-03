-- 0006_notes.sql
-- Notes attached to people, projects, or tasks. Free-form markdown the user
-- jots into the web UI. Briefs already cover "this is the AI summary" — Notes
-- is "this is what I want to remember about this entity".

CREATE TABLE IF NOT EXISTS Notes (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  noteId      TEXT DEFAULT '',
  entityType  TEXT DEFAULT '',  -- 'person' | 'project' | 'task'
  entityId    TEXT DEFAULT '',
  body        TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  updatedAt   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notes_noteId ON Notes(noteId);
CREATE INDEX IF NOT EXISTS idx_notes_entity ON Notes(entityType, entityId);
