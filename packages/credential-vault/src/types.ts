/**
 * A generic credential is any opaque secret string an agent needs to replay
 * against a third-party service: a cookie blob, a long-lived session JWT, a
 * scraped CSRF token, an API key. OAuth tokens with refresh flows belong in
 * provider-specific packages (e.g. @agentbuilder/auth-google) which can
 * encode the refresh logic.
 */

export type CredentialKind =
  | 'cookie'        // Cookie header value (one or more name=value; pairs)
  | 'session_jwt'   // Long-lived session JWT issued by the provider
  | 'api_key'       // Personal API key / token
  | 'bearer'        // Bearer token (non-refreshing)
  | 'basic';        // base64("user:pass")

export interface CredentialKey {
  /** Owning agent (e.g. "research-agent", "wired-watcher"). Required so a
   *  vault read cannot return another agent's credentials. */
  agentId: string;
  /** External account identifier — the user's handle/email at the provider,
   *  or "default" for single-account agents. */
  accountId: string;
  /** Provider slug — "wired", "medium", "charter", etc. */
  provider: string;
  /** Credential kind. A single (agent, account, provider) tuple may hold
   *  multiple kinds (e.g. cookie + csrf token). */
  kind: CredentialKind;
}

export interface StoredCredential extends CredentialKey {
  /** Plaintext credential value. Encrypted at rest; decrypted on read. */
  value: string;
  /** Optional opaque metadata: cookie domain, scopes, original UA string,
   *  whatever the caller wants to round-trip. JSON-serialisable. */
  metadata: Record<string, unknown> | null;
  /** Optional expiry (epoch ms). Reads do NOT auto-filter on this — callers
   *  decide whether to use a stale credential. */
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialListFilter {
  agentId: string;
  /** Optional provider scope; omit to list all providers for the agent. */
  provider?: string;
  /** Optional account scope. */
  accountId?: string;
}
