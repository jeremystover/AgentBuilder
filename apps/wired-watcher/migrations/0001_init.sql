-- wired-watcher: credential vault for cookie storage.
-- Mirror of CREDENTIAL_VAULT_SCHEMA exported from @agentbuilder/credential-vault.

CREATE TABLE IF NOT EXISTS vault_credentials (
  agent_id    TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value_enc   TEXT NOT NULL,
  metadata    TEXT,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (agent_id, account_id, provider, kind)
);

CREATE INDEX IF NOT EXISTS idx_vault_credentials_agent_provider
  ON vault_credentials(agent_id, provider);
