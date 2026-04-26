-- 0007_focus_now.sql
-- FocusNow holds the current "what I'm focusing on right now" task list.
-- Backed by the /now page: tasks are pulled in to focus, and the "Release"
-- button clears the table. Items reference Tasks by taskKey.

CREATE TABLE IF NOT EXISTS FocusNow (
  _row_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  taskKey   TEXT DEFAULT '',
  position  INTEGER DEFAULT 0,
  addedAt   TEXT DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_focusnow_taskKey ON FocusNow(taskKey);
CREATE INDEX IF NOT EXISTS idx_focusnow_position ON FocusNow(position);
