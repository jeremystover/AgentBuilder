/**
 * TokenVault: the ONLY way an agent should read/write Google tokens.
 *
 * Every read is scoped by agentId. Attempting to fetch another agent's
 * tokens is impossible through this surface — a cross-agent leak would
 * require bypassing this class entirely, which shows up in code review.
 *
 * Tokens are encrypted at rest in D1 using AES-256-GCM with a KEK from
 * Cloudflare Secrets Store.
 */

import { AgentError } from '@agentbuilder/core';
import { decryptToken, encryptToken } from './crypto.js';
import type { StoredGoogleToken, TokenLookupKey } from './types.js';

export interface TokenVault {
  get(key: TokenLookupKey): Promise<StoredGoogleToken | null>;
  put(token: StoredGoogleToken): Promise<void>;
  delete(key: TokenLookupKey): Promise<void>;
}

export interface D1TokenVaultOptions {
  db: D1Database;
  /** KEK (Key Encryption Key) from Cloudflare Secrets Store, required for production */
  encryptionKey: CryptoKey;
}

export class D1TokenVault implements TokenVault {
  private readonly db: D1Database;
  private readonly encryptionKey: CryptoKey;

  constructor(opts: D1TokenVaultOptions) {
    this.db = opts.db;
    this.encryptionKey = opts.encryptionKey;
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
      accessToken: await decryptToken(row.access_token, this.encryptionKey),
      refreshToken: row.refresh_token ? await decryptToken(row.refresh_token, this.encryptionKey) : null,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async put(token: StoredGoogleToken): Promise<void> {
    const encryptedAccessToken = await encryptToken(token.accessToken, this.encryptionKey);
    const encryptedRefreshToken = token.refreshToken
      ? await encryptToken(token.refreshToken, this.encryptionKey)
      : null;

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
        encryptedAccessToken,
        encryptedRefreshToken,
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
