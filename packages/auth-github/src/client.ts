/**
 * GitHub App client with RS256 JWT signing and installation token minting.
 *
 * The client uses the GitHub App's private key to sign RS256 JWTs, which are
 * then exchanged for installation tokens scoped to specific repositories.
 */

import { AgentError } from '@agentbuilder/core';
import { importPrivateKey, signGitHubAppJwt } from './jwt.js';
import type { GitHubAppConfig, InstallationToken } from './types.js';

export interface GitHubClientOptions {
  config: GitHubAppConfig;
  /** Override the API base for testing */
  apiBase?: string;
}

export class GitHubClient {
  private readonly config: GitHubAppConfig;
  private readonly apiBase: string;
  private cachedPrivateKey: CryptoKey | null = null;

  constructor(opts: GitHubClientOptions) {
    this.config = opts.config;
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
  }

  /**
   * Mint a fresh installation token scoped to the repos the caller specifies.
   * GitHub tokens expire in 1 hour; callers should cache and reuse until 30s
   * before expiry to minimize API calls.
   */
  async getInstallationToken(repositories: string[]): Promise<InstallationToken> {
    try {
      // Import and cache the private key
      if (!this.cachedPrivateKey) {
        this.cachedPrivateKey = await importPrivateKey(this.config.privateKey);
      }

      // Sign a JWT with the app's private key
      const jwt = await signGitHubAppJwt(this.config.appId, this.cachedPrivateKey);

      // Exchange JWT for an installation access token
      const response = await fetch(
        `${this.apiBase}/app/installations/${this.config.installationId}/access_tokens`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({
            repositories,
            permissions: {
              contents: 'write',
              pull_requests: 'write',
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as {
        token: string;
        expires_at: string;
      };

      return {
        token: data.token,
        expiresAt: new Date(data.expires_at).getTime(),
        repositories,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentError(`Failed to mint GitHub installation token: ${message}`, {
        code: 'unauthorized',
        details: { appId: this.config.appId, installationId: this.config.installationId },
      });
    }
  }
}
