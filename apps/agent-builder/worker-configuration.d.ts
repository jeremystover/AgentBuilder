// Ambient Env type for the agent-builder Worker. Keep in sync with wrangler.toml.
export interface Env {
  AGENT_BUILDER_DO: DurableObjectNamespace;
  AI: Ai;
  DB: D1Database;

  ANTHROPIC_API_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
}
