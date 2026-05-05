-- 0009_waiting_tasks.sql
-- Adds first-class "waiting" status fields to Tasks. A waiting task is one
-- the user is tracking but can't act on right now (waiting on a person, a
-- date, a blocking task, time/focus, an external event, or someone they
-- delegated it to). The morning brief uses these fields to resurface a
-- waiting task at the right moment instead of leaving it stale in notes.
--
-- assigned-to-other waits also write a sibling Commitments row (existing
-- table) and link it via Tasks.commitmentId, so the existing Mon-9am
-- commitment-nudge cron handles delegation follow-up automatically.

ALTER TABLE Tasks ADD COLUMN waitReason TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN waitDetail TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN expectedBy TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN nextCheckAt TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN lastSnoozedAt TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN lastSignalAt TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN waitOnStakeholderId TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN waitOnName TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN waitChannel TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN blockedByTaskKey TEXT DEFAULT '';
ALTER TABLE Tasks ADD COLUMN commitmentId TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_tasks_nextCheckAt ON Tasks(nextCheckAt);
CREATE INDEX IF NOT EXISTS idx_tasks_blockedBy ON Tasks(blockedByTaskKey);
