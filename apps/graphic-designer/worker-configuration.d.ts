export interface Env {
  ASSETS: Fetcher;
  AGENT_DO: DurableObjectNamespace;
  AI: Ai;
  DB: D1Database;
  BUCKET: R2Bucket;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  UNSPLASH_ACCESS_KEY: string;
  PEXELS_API_KEY: string;
  CANVA_API_KEY: string;
  MCP_HTTP_KEY: string;
  GOOGLE_TOKEN_VAULT_KEK: string;
}
