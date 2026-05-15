-- Fleet-wide error capture + bug triage.
-- fleet_errors  — one row per error occurrence (request/cron/queue/frontend).
-- bug_tickets   — one row per fingerprint, with triage + fix state.
-- bug_fixes     — append-only audit of what the fleet-doctor did.
-- The /fleet-doctor scheduled session reads bug_tickets to know what to fix.

CREATE TABLE IF NOT EXISTS fleet_errors (
  error_id    TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  source      TEXT NOT NULL,        -- request | cron | queue | frontend
  fingerprint TEXT NOT NULL,
  message     TEXT DEFAULT '',
  stack       TEXT DEFAULT '',
  context     TEXT DEFAULT '',      -- JSON
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fleet_errors_fingerprint
  ON fleet_errors(fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_errors_agent_created
  ON fleet_errors(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bug_tickets (
  fingerprint        TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL,
  source             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',  -- open|investigating|fixed|needs_human|wontfix
  sample_message     TEXT DEFAULT '',
  occurrences        INTEGER DEFAULT 1,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL,
  fix_attempts       INTEGER DEFAULT 0,
  last_attempt_at    TEXT DEFAULT '',
  resolution_summary TEXT DEFAULT '',
  pr_url             TEXT DEFAULT '',
  github_issue       INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bug_tickets_status
  ON bug_tickets(status, last_seen DESC);

CREATE TABLE IF NOT EXISTS bug_fixes (
  fix_id      TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  pr_url      TEXT DEFAULT '',
  commit_sha  TEXT DEFAULT '',
  summary     TEXT DEFAULT '',
  outcome     TEXT DEFAULT '',      -- fixed | flagged | wontfix
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bug_fixes_created
  ON bug_fixes(created_at DESC);
