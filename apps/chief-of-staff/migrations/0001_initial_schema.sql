-- 0001_initial_schema.sql
-- Migrates chief-of-staff data store from Google Sheets to Cloudflare D1.
-- All columns are TEXT to match Sheets' untyped storage model.
-- _row_id provides the rowNum concept used by updateRow / findRowByKey.

-- ── Tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Tasks (
  _row_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  taskKey   TEXT DEFAULT '',
  source    TEXT DEFAULT '',
  subject   TEXT DEFAULT '',
  title     TEXT DEFAULT '',
  "from"    TEXT DEFAULT '',
  date      TEXT DEFAULT '',
  startTime TEXT DEFAULT '',
  endTime   TEXT DEFAULT '',
  status    TEXT DEFAULT '',
  priority  TEXT DEFAULT '',
  notes     TEXT DEFAULT '',
  rawJson   TEXT DEFAULT '',
  updatedAt TEXT DEFAULT '',
  ownerType TEXT DEFAULT '',
  ownerId   TEXT DEFAULT '',
  dueAt     TEXT DEFAULT '',
  projectId TEXT DEFAULT '',
  confidence TEXT DEFAULT '',
  origin    TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tasks_taskKey    ON Tasks(taskKey);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON Tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_projectId  ON Tasks(projectId);

-- ── TaskSources ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS TaskSources (
  _row_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  sourceId   TEXT DEFAULT '',
  taskKey    TEXT DEFAULT '',
  sourceType TEXT DEFAULT '',
  sourceRef  TEXT DEFAULT '',
  sourceUri  TEXT DEFAULT '',
  excerpt    TEXT DEFAULT '',
  confidence TEXT DEFAULT '',
  createdAt  TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tasksources_taskKey ON TaskSources(taskKey);

-- ── Commitments ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Commitments (
  _row_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  commitmentId  TEXT DEFAULT '',
  ownerType     TEXT DEFAULT '',
  ownerId       TEXT DEFAULT '',
  description   TEXT DEFAULT '',
  dueAt         TEXT DEFAULT '',
  status        TEXT DEFAULT '',
  sourceType    TEXT DEFAULT '',
  sourceRef     TEXT DEFAULT '',
  excerpt       TEXT DEFAULT '',
  projectId     TEXT DEFAULT '',
  stakeholderId TEXT DEFAULT '',
  lastNudgedAt  TEXT DEFAULT '',
  createdAt     TEXT DEFAULT '',
  updatedAt     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_commitments_commitmentId ON Commitments(commitmentId);
CREATE INDEX IF NOT EXISTS idx_commitments_status       ON Commitments(status);

-- ── IntakeQueue ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS IntakeQueue (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  intakeId    TEXT DEFAULT '',
  kind        TEXT DEFAULT '',
  summary     TEXT DEFAULT '',
  sourceRef   TEXT DEFAULT '',
  payloadJson TEXT DEFAULT '',
  status      TEXT DEFAULT '',
  createdAt   TEXT DEFAULT '',
  updatedAt   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_intake_intakeId ON IntakeQueue(intakeId);
CREATE INDEX IF NOT EXISTS idx_intake_status   ON IntakeQueue(status);

-- ── Changesets ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Changesets (
  _row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  changesetId  TEXT DEFAULT '',
  kind         TEXT DEFAULT '',
  status       TEXT DEFAULT '',
  proposedAt   TEXT DEFAULT '',
  proposedBy   TEXT DEFAULT '',
  addsJson     TEXT DEFAULT '',
  updatesJson  TEXT DEFAULT '',
  deletesJson  TEXT DEFAULT '',
  appliedAt    TEXT DEFAULT '',
  appliedBy    TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_changesets_changesetId ON Changesets(changesetId);
CREATE INDEX IF NOT EXISTS idx_changesets_status      ON Changesets(status);

-- ── Config ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Config (
  _row_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT DEFAULT '',
  value     TEXT DEFAULT '',
  updatedAt TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_config_key ON Config(key);

-- ── Stakeholders ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Stakeholders (
  _row_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stakeholderId      TEXT DEFAULT '',
  name               TEXT DEFAULT '',
  email              TEXT DEFAULT '',
  tierTag            TEXT DEFAULT '',
  cadenceDays        TEXT DEFAULT '',
  lastInteractionAt  TEXT DEFAULT '',
  relationshipHealth TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_stakeholders_stakeholderId ON Stakeholders(stakeholderId);

-- ── Goals ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Goals (
  _row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goalId           TEXT DEFAULT '',
  title            TEXT DEFAULT '',
  description      TEXT DEFAULT '',
  horizon          TEXT DEFAULT '',
  quarter          TEXT DEFAULT '',
  status           TEXT DEFAULT '',
  priority         TEXT DEFAULT '',
  targetDate       TEXT DEFAULT '',
  successCriteria  TEXT DEFAULT '',
  stakeholdersJson TEXT DEFAULT '',
  notes            TEXT DEFAULT '',
  sourceType       TEXT DEFAULT '',
  sourceRef        TEXT DEFAULT '',
  createdAt        TEXT DEFAULT '',
  updatedAt        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_goals_goalId  ON Goals(goalId);
CREATE INDEX IF NOT EXISTS idx_goals_status  ON Goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_quarter ON Goals(quarter);

-- ── Projects ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Projects (
  _row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId        TEXT DEFAULT '',
  name             TEXT DEFAULT '',
  goalId           TEXT DEFAULT '',
  description      TEXT DEFAULT '',
  status           TEXT DEFAULT '',
  priority         TEXT DEFAULT '',
  healthStatus     TEXT DEFAULT '',
  nextMilestoneAt  TEXT DEFAULT '',
  stakeholdersJson TEXT DEFAULT '',
  notes            TEXT DEFAULT '',
  sourceType       TEXT DEFAULT '',
  sourceRef        TEXT DEFAULT '',
  createdAt        TEXT DEFAULT '',
  lastTouchedAt    TEXT DEFAULT '',
  updatedAt        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_projects_projectId ON Projects(projectId);
CREATE INDEX IF NOT EXISTS idx_projects_goalId    ON Projects(goalId);
CREATE INDEX IF NOT EXISTS idx_projects_status    ON Projects(status);

-- ── Meetings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Meetings (
  _row_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  meetingId            TEXT DEFAULT '',
  eventId              TEXT DEFAULT '',
  title                TEXT DEFAULT '',
  startTime            TEXT DEFAULT '',
  endTime              TEXT DEFAULT '',
  description          TEXT DEFAULT '',
  location             TEXT DEFAULT '',
  organizer            TEXT DEFAULT '',
  attendeesJson        TEXT DEFAULT '',
  sourceType           TEXT DEFAULT '',
  sourceDomain         TEXT DEFAULT '',
  sourceRef            TEXT DEFAULT '',
  rawJson              TEXT DEFAULT '',
  transcriptRef        TEXT DEFAULT '',
  zoomMeetingId        TEXT DEFAULT '',
  zoomRecordingId      TEXT DEFAULT '',
  actionItemsExtracted TEXT DEFAULT '',
  createdAt            TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_meetings_meetingId ON Meetings(meetingId);
CREATE INDEX IF NOT EXISTS idx_meetings_eventId   ON Meetings(eventId);

-- ── Decisions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Decisions (
  _row_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  decisionId       TEXT DEFAULT '',
  title            TEXT DEFAULT '',
  decisionText     TEXT DEFAULT '',
  rationale        TEXT DEFAULT '',
  projectId        TEXT DEFAULT '',
  stakeholdersJson TEXT DEFAULT '',
  decisionDate     TEXT DEFAULT '',
  revisitDate      TEXT DEFAULT '',
  status           TEXT DEFAULT '',
  sourceType       TEXT DEFAULT '',
  sourceRef        TEXT DEFAULT '',
  excerpt          TEXT DEFAULT '',
  createdAt        TEXT DEFAULT '',
  updatedAt        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_decisions_decisionId ON Decisions(decisionId);

-- ── PeriodReviews ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS PeriodReviews (
  _row_id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewId               TEXT DEFAULT '',
  periodType             TEXT DEFAULT '',
  startDate              TEXT DEFAULT '',
  endDate                TEXT DEFAULT '',
  tasksCompletedJson     TEXT DEFAULT '',
  tasksMissedJson        TEXT DEFAULT '',
  decisionsJson          TEXT DEFAULT '',
  commitmentsJson        TEXT DEFAULT '',
  relationshipHealthJson TEXT DEFAULT '',
  notesText              TEXT DEFAULT '',
  generatedAt            TEXT DEFAULT '',
  generatedBy            TEXT DEFAULT '',
  updatedAt              TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_periodreviews_reviewId ON PeriodReviews(reviewId);

-- ── AgentRuns ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS AgentRuns (
  _row_id              INTEGER PRIMARY KEY AUTOINCREMENT,
  runId                TEXT DEFAULT '',
  sessionType          TEXT DEFAULT '',
  summary              TEXT DEFAULT '',
  toolsCalledJson      TEXT DEFAULT '',
  changesetsAppliedJson TEXT DEFAULT '',
  startedAt            TEXT DEFAULT '',
  completedAt          TEXT DEFAULT '',
  runBy                TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_agentruns_runId ON AgentRuns(runId);

-- ── CronRuns ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS CronRuns (
  _row_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  runId        TEXT DEFAULT '',
  trigger      TEXT DEFAULT '',
  startedAt    TEXT DEFAULT '',
  completedAt  TEXT DEFAULT '',
  durationMs   TEXT DEFAULT '',
  status       TEXT DEFAULT '',
  summary      TEXT DEFAULT '',
  errorSummary TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cronruns_runId ON CronRuns(runId);

-- ── Errors ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS Errors (
  _row_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  errorId     TEXT DEFAULT '',
  scope       TEXT DEFAULT '',
  message     TEXT DEFAULT '',
  stack       TEXT DEFAULT '',
  contextJson TEXT DEFAULT '',
  createdAt   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_errors_errorId ON Errors(errorId);
