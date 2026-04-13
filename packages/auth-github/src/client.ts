/**
 * GitHub App client. Phase-1 stub — the methods exist so callers can wire
 * against them, but minting installation tokens lands in phase 2 along
 * with the JWT signing implementation (Web Crypto, RS256).
 */

import { AgentError } from '@agentbuilder/core';
import type { GitHubAppConfig, InstallationToken } from './types.js';

export interface GitHubClientOptions {
  config: GitHubAppConfig;
  /** Override the API base for testing */
  apiBase?: string;
}

export class GitHubClient {
  private readonly config: GitHubAppConfig;

  constructor(opts: GitHubClientOptions) {
    this.config = opts.config;
  }

  /**
   * Mint a fresh installation token scoped to the repos the caller specifies.
   * Phase 2 will cache tokens by (agentId, repoSetHash) until 30s before expiry.
   */
  async getInstallationToken(_repositories: string[]): Promise<InstallationToken> {
    // TODO(phase2): sign an RS256 JWT with this.config.privateKey, POST to
    // /app/installations/{installation_id}/access_tokens with `repositories`.
    throw new AgentError('GitHubClient.getInstallationToken not yet implemented', {
      code: 'internal',
      details: { phase: 1, config: { appId: this.config.appId } },
    });
  }
}
