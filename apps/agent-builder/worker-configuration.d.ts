// Ambient Env type for the agent-builder Worker. Keep in sync with wrangler.toml.
export interface Env {
  AGENT_BUILDER_DO: DurableObjectNamespace;
  AI: Ai;
  DB: D1Database;

  // Fleet D1 read-only bindings for the /dashboard browser. Optional so a
  // missing binding (e.g. agent's DB not yet provisioned) just hides that
  // entry rather than breaking the worker.
  DB_CFO?: D1Database;
  DB_CHIEF_OF_STAFF?: D1Database;
  DB_GUEST_BOOKING?: D1Database;
  DB_GRAPHIC_DESIGNER?: D1Database;
  DB_RESEARCH_AGENT?: D1Database;

  ANTHROPIC_API_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;

  // /dashboard auth — required.
  WEB_UI_PASSWORD?: string;
  EXTERNAL_API_KEY?: string;
  MCP_HTTP_KEY?: string;
}
