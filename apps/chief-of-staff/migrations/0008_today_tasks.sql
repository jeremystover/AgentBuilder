-- 0008_today_tasks.sql
-- TodayTasks tracks user-curated "do this today" designations on tasks.
-- A row pins a Tasks.taskKey to a specific calendar day (yyyy-mm-dd). The
-- /api/today and /api/now (Quick Wins) views look up rows for the current
-- dayKey, so the designation auto-expires when the day rolls over without
-- any cron job. Completing or removing the task drops it from the view via
-- the open-status filter; the user can also explicitly unmark.

CREATE TABLE IF NOT EXISTS TodayTasks (
  _row_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  taskKey   TEXT NOT NULL,
  dayKey    TEXT NOT NULL,
  addedAt   TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_todaytasks_key_day ON TodayTasks(taskKey, dayKey);
CREATE INDEX IF NOT EXISTS idx_todaytasks_day ON TodayTasks(dayKey);
