export interface GoogleOAuthClientConfig {
  /** Shared client id from the single Google Cloud OAuth client */
  clientId: string;
  /** Shared client secret, read from Cloudflare Secrets Store */
  clientSecret: string;
  /** Redirect URI — typically https://<worker>/oauth/google/callback */
  redirectUri: string;
}

export interface StoredGoogleToken {
  agentId: string;
  userId: string;
  /** Sorted, space-separated scopes so equality checks are trivial */
  scopes: string;
  accessToken: string;
  refreshToken: string | null;
  /** ms since epoch */
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface TokenLookupKey {
  agentId: string;
  userId: string;
}
