/**
 * D1-backed credential vault.
 *
 * Every read is scoped by agentId. Cross-agent access requires bypassing
 * this class entirely, which would show up in code review.
 *
 * Values are encrypted at rest with AES-256-GCM using a Key Encryption Key
 * (KEK) sourced from Cloudflare Secrets Store.
 */

import { AgentError } from '@agentbuilder/core';
import { decrypt, encrypt } from '@agentbuilder/crypto';
import type {
  CredentialKey,
  CredentialListFilter,
  StoredCredential,
} from './types.js';

export interface CredentialVault {
  get(key: CredentialKey): Promise<StoredCredential | null>;
  put(cred: StoredCredential): Promise<void>;
  delete(key: CredentialKey): Promise<void>;
  list(filter: CredentialListFilter): Promise<StoredCredential[]>;
}

export interface D1CredentialVaultOptions {
  db: D1Database;
  encryptionKey: CryptoKey;
}

interface RawRow {
  agent_id: string;
  account_id: string;
  provider: string;
  kind: string;
  value_enc: string;
  metadata: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export class D1CredentialVault implements CredentialVault {
  private readonly db: D1Database;
  private readonly key: CryptoKey;

  constructor(opts: D1CredentialVaultOptions) {
    this.db = opts.db;
    this.key = opts.encryptionKey;
  }

  async get(key: CredentialKey): Promise<StoredCredential | null> {
    requireKey(key);
    const row = await this.db
      .prepare(
        `SELECT agent_id, account_id, provider, kind, value_enc, metadata,
                expires_at, created_at, updated_at
         FROM vault_credentials
         WHERE agent_id = ?1 AND account_id = ?2 AND provider = ?3 AND kind = ?4`,
      )
      .bind(key.agentId, key.accountId, key.provider, key.kind)
      .first<RawRow>();
    if (!row) return null;
    return this.hydrate(row);
  }

  async put(cred: StoredCredential): Promise<void> {
    requireKey(cred);
    const valueEnc = await encrypt(cred.value, this.key);
    const metadata = cred.metadata ? JSON.stringify(cred.metadata) : null;
    await this.db
      .prepare(
        `INSERT INTO vault_credentials
           (agent_id, account_id, provider, kind, value_enc, metadata,
            expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(agent_id, account_id, provider, kind) DO UPDATE SET
           value_enc  = excluded.value_enc,
           metadata   = excluded.metadata,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        cred.agentId,
        cred.accountId,
        cred.provider,
        cred.kind,
        valueEnc,
        metadata,
        cred.expiresAt,
        cred.createdAt,
        cred.updatedAt,
      )
      .run();
  }

  async delete(key: CredentialKey): Promise<void> {
    requireKey(key);
    await this.db
      .prepare(
        `DELETE FROM vault_credentials
         WHERE agent_id = ?1 AND account_id = ?2 AND provider = ?3 AND kind = ?4`,
      )
      .bind(key.agentId, key.accountId, key.provider, key.kind)
      .run();
  }

  async list(filter: CredentialListFilter): Promise<StoredCredential[]> {
    if (!filter.agentId) {
      throw new AgentError('CredentialVault.list requires agentId', { code: 'invalid_input' });
    }
    const clauses = ['agent_id = ?1'];
    const binds: unknown[] = [filter.agentId];
    if (filter.provider) {
      clauses.push(`provider = ?${binds.length + 1}`);
      binds.push(filter.provider);
    }
    if (filter.accountId) {
      clauses.push(`account_id = ?${binds.length + 1}`);
      binds.push(filter.accountId);
    }
    const result = await this.db
      .prepare(
        `SELECT agent_id, account_id, provider, kind, value_enc, metadata,
                expires_at, created_at, updated_at
         FROM vault_credentials
         WHERE ${clauses.join(' AND ')}
         ORDER BY provider, account_id, kind`,
      )
      .bind(...binds)
      .all<RawRow>();
    const rows = result.results ?? [];
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  private async hydrate(row: RawRow): Promise<StoredCredential> {
    return {
      agentId: row.agent_id,
      accountId: row.account_id,
      provider: row.provider,
      kind: row.kind as StoredCredential['kind'],
      value: await decrypt(row.value_enc, this.key),
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function requireKey(key: CredentialKey): void {
  if (!key.agentId || !key.accountId || !key.provider || !key.kind) {
    throw new AgentError(
      'CredentialVault key requires agentId, accountId, provider, and kind',
      { code: 'invalid_input' },
    );
  }
}
