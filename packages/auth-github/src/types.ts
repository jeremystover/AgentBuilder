export interface GitHubAppConfig {
  appId: string;
  /** PEM-encoded private key from Cloudflare Secrets Store */
  privateKey: string;
  /** The single org-level installation id for our GitHub App */
  installationId: string;
}

export interface InstallationToken {
  token: string;
  /** ms since epoch */
  expiresAt: number;
  /** Repositories the token is scoped to */
  repositories: string[];
}
