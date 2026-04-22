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
}
