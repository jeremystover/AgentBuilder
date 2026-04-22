export interface Env {
  AGENT_DO: DurableObjectNamespace;
  AI: Ai;
  ANTHROPIC_API_KEY: string;

  // MCP bearer key. If unset, /mcp skips auth (dev-only).
  MCP_HTTP_KEY?: string;

  // Shared D1 database for the Google token vault.
  DB?: D1Database;

  // Base64-encoded AES-256 key encryption key (KEK) for the token vault.
  GOOGLE_TOKEN_VAULT_KEK?: string;

  // Google OAuth 2.0 client credentials (the shared fleet client, or a
  // dedicated client registered with /oauth/google/callback as an
  // authorized redirect URI).
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;

  // HMAC secret for signing the OAuth `state` parameter. Falls back to
  // MCP_HTTP_KEY when unset (both are Worker-only secrets).
  OAUTH_STATE_SECRET?: string;
}
