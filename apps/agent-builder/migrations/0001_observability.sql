-- Fleet-wide cron + error logging.
-- Written to by every agent's scheduled() handler via @agentbuilder/observability.
-- Read by the /dashboard UI in this Worker.

CREATE TABLE IF NOT EXISTS cron_runs (
  run_id        TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  cron_expr     TEXT DEFAULT '',
  started_at    TEXT NOT NULL,
  completed_at  TEXT DEFAULT '',
  duration_ms   INTEGER DEFAULT 0,
  status        TEXT NOT NULL,
  summary       TEXT DEFAULT '',
  error_summary TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_agent_started
  ON cron_runs(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status
  ON cron_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_trigger_started
  ON cron_runs(agent_id, trigger, started_at DESC);

CREATE TABLE IF NOT EXISTS cron_errors (
  error_id    TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  scope       TEXT NOT NULL,
  message     TEXT DEFAULT '',
  stack       TEXT DEFAULT '',
  context     TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cron_errors_agent_created
  ON cron_errors(agent_id, created_at DESC);
