-- Deploy confirmation log.
-- Written by .github/workflows/_deploy-agent.yml after every deploy attempt.
-- Claude Code web sessions query this table (via the Cloudflare MCP) to
-- confirm a deploy succeeded, since outbound curl to *.workers.dev is blocked.

CREATE TABLE IF NOT EXISTS deployments (
  deploy_id    TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  git_sha      TEXT NOT NULL,
  version_id   TEXT DEFAULT '',
  status       TEXT NOT NULL,        -- success | failed
  smoke_status TEXT DEFAULT '',      -- ok | fail | skipped
  deployed_at  TEXT NOT NULL,
  actor        TEXT DEFAULT '',
  notes        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_deployments_agent_time
  ON deployments(agent_id, deployed_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_sha
  ON deployments(git_sha);
