/**
 * TokenVault: the ONLY way an agent should read/write Google tokens.
 *
 * Every read is scoped by agentId. Attempting to fetch another agent's
 * tokens is impossible through this surface — a cross-agent leak would
 * require bypassing this class entirely, which shows up in code review.
 *
 * Phase 1: interface + D1 plumbing. Encryption + the OAuth dance land
 * in phase 2 — for now `encrypt`/`decrypt` are identity functions so
 * we can wire call sites without the KEK infrastructure yet. DO NOT
 * deploy this to production without fixing those.
 */

import { AgentError } from '@agentbuilder/core';
import type { StoredGoogleToken, TokenLookupKey } from './types.js';

export interface TokenVault {
  get(key: TokenLookupKey): Promise<StoredGoogleToken | null>;
  put(token: StoredGoogleToken): Promise<void>;
  delete(key: TokenLookupKey): Promise<void>;
}

export interface D1TokenVaultOptions {
  db: D1Database;
  /** Reserved for phase 2: KEK pulled from Secrets Store */
  encryptionKey?: CryptoKey;
}

export class D1TokenVault implements TokenVault {
  private readonly db: D1Database;

  constructor(opts: D1TokenVaultOptions) {
    this.db = opts.db;
  }

  async get(key: TokenLookupKey): Promise<StoredGoogleToken | null> {
    if (!key.agentId || !key.userId) {
      throw new AgentError('TokenVault.get requires agentId and userId', {
        code: 'invalid_input',
      });
    }
    const row = await this.db
      .prepare(
        `SELECT agent_id, user_id, scopes, access_token, refresh_token,
                expires_at, created_at, updated_at
         FROM google_tokens
         WHERE agent_id = ?1 AND user_id = ?2`,
      )
      .bind(key.agentId, key.userId)
      .first<RawTokenRow>();

    if (!row) return null;
    return {
      agentId: row.agent_id,
      userId: row.user_id,
      scopes: row.scopes,
      accessToken: decrypt(row.access_token),
      refreshToken: row.refresh_token ? decrypt(row.refresh_token) : null,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async put(token: StoredGoogleToken): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO google_tokens
          (agent_id, user_id, scopes, access_token, refresh_token,
           expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(agent_id, user_id) DO UPDATE SET
           scopes = excluded.scopes,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        token.agentId,
        token.userId,
        token.scopes,
        encrypt(token.accessToken),
        token.refreshToken ? encrypt(token.refreshToken) : null,
        token.expiresAt,
        token.createdAt,
        token.updatedAt,
      )
      .run();
  }

  async delete(key: TokenLookupKey): Promise<void> {
    await this.db
      .prepare(`DELETE FROM google_tokens WHERE agent_id = ?1 AND user_id = ?2`)
      .bind(key.agentId, key.userId)
      .run();
  }
}

interface RawTokenRow {
  agent_id: string;
  user_id: string;
  scopes: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

// TODO(phase2): replace with AES-GCM using a KEK from Cloudflare Secrets Store.
// Until then, every caller MUST treat stored values as sensitive.
function encrypt(value: string): string {
  return value;
}

function decrypt(value: string): string {
  return value;
}
