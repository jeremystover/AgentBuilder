export interface Env {
  // Database
  HYPERDRIVE: Hyperdrive;

  // Storage
  STORAGE: R2Bucket;

  // Queue
  SCENARIO_QUEUE: Queue;

  // Assets (SPA)
  ASSETS: Fetcher;

  // Auth (web-ui-kit)
  WEB_UI_PASSWORD: string;
  EXTERNAL_API_KEY: string;
  MCP_HTTP_KEY: string;
  WEB_UI_USER_ID?: string;

  // LLM
  ANTHROPIC_API_KEY: string;

  // Teller
  TELLER_APPLICATION_ID: string;
  TELLER_ENV: string;
  TELLER_MTLS?: Fetcher;

  // Fleet observability
  AGENTBUILDER_CORE_DB: D1Database;

  // Google OAuth token vault (D1) + fleet-wide OAuth client
  TOKENS: D1Database;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  GOOGLE_TOKEN_VAULT_KEK: string;
}

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
