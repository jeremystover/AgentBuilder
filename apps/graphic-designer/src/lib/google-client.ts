/**
 * Thin wrapper over @agentbuilder/auth-google's D1TokenVault.
 *
 * Responsibilities:
 *   - Load an access token for (agentId='graphic-designer', userId)
 *   - Refresh via Google's token endpoint when expired (using the vault's refresh token)
 *   - Provide gfetch() that adds Authorization: Bearer <token>
 *
 * This is the ONLY place in the agent that reads Google tokens directly.
 */

import { D1TokenVault, importKey, type StoredGoogleToken } from '@agentbuilder/auth-google';
import { AgentError } from '@agentbuilder/core';
import type { Env } from '../../worker-configuration';

const AGENT_ID = 'graphic-designer';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_SKEW_MS = 60_000;

export interface GoogleClientOptions {
  env: Env;
  userId: string;
}

export class GoogleClient {
  private readonly env: Env;
  private readonly userId: string;
  private vault: D1TokenVault | null = null;

  constructor(opts: GoogleClientOptions) {
    this.env = opts.env;
    this.userId = opts.userId;
  }

  private async getVault(): Promise<D1TokenVault> {
    if (this.vault) return this.vault;
    const kekBytes = base64ToBytes(this.env.GOOGLE_TOKEN_VAULT_KEK);
    const key = await importKey(kekBytes.buffer as ArrayBuffer);
    this.vault = new D1TokenVault({ db: this.env.DB, encryptionKey: key });
    return this.vault;
  }

  async getAccessToken(): Promise<string> {
    const vault = await this.getVault();
    const stored = await vault.get({ agentId: AGENT_ID, userId: this.userId });
    if (!stored) {
      throw new AgentError(
        `No Google token for user "${this.userId}". Complete OAuth at /api/auth/google/start first.`,
        { code: 'unauthorized' },
      );
    }

    if (stored.expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return stored.accessToken;
    }

    if (!stored.refreshToken) {
      throw new AgentError('Token expired and no refresh token available; re-authenticate.', {
        code: 'unauthorized',
      });
    }

    return this.refreshAccessToken(stored);
  }

  private async refreshAccessToken(stored: StoredGoogleToken): Promise<string> {
    const clientId = (this.env as unknown as Record<string, string>).GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = (this.env as unknown as Record<string, string>).GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new AgentError('GOOGLE_OAUTH_CLIENT_ID / CLIENT_SECRET not set.', { code: 'internal' });
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken as string,
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new AgentError(`Google token refresh failed: ${text}`, { code: 'upstream_failure' });
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
    };

    const now = Date.now();
    const fresh: StoredGoogleToken = {
      agentId: AGENT_ID,
      userId: this.userId,
      scopes: json.scope ?? stored.scopes,
      accessToken: json.access_token,
      refreshToken: stored.refreshToken,
      expiresAt: now + json.expires_in * 1000,
      createdAt: stored.createdAt,
      updatedAt: now,
    };
    const vault = await this.getVault();
    await vault.put(fresh);
    return fresh.accessToken;
  }

  async gfetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers ?? {});
    headers.set('authorization', `Bearer ${token}`);
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(url, { ...init, headers });
  }

  async storeToken(input: {
    accessToken: string;
    refreshToken: string | null;
    scopes: string;
    expiresIn: number;
  }): Promise<void> {
    const vault = await this.getVault();
    const now = Date.now();
    await vault.put({
      agentId: AGENT_ID,
      userId: this.userId,
      scopes: input.scopes,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: now + input.expiresIn * 1000,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
