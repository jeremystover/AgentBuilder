/**
 * D1 schema for the generic credential vault. Apply via
 * `wrangler d1 migrations apply` after creating the database.
 *
 * One row per (agent_id, account_id, provider, kind) tuple. The composite
 * primary key prevents an agent from accidentally reading another agent's
 * credentials at the SQL layer; the vault class enforces it again in code.
 */

export const CREDENTIAL_VAULT_SCHEMA = /* sql */ `
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
`;
