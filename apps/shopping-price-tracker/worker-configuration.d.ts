import type { EmailMessage } from "cloudflare:email";

export interface SendEmailBinding {
  send(message: EmailMessage): Promise<void>;
}

export interface Env {
  ASSETS: Fetcher;
  AGENT_DO: DurableObjectNamespace;
  DB: D1Database;
  AGENTBUILDER_CORE_DB?: D1Database;
  SEND_EMAIL?: SendEmailBinding;

  ENVIRONMENT?: string;
  DIGEST_FROM?: string;

  MCP_HTTP_KEY?: string;
  WEB_UI_PASSWORD?: string;
  EXTERNAL_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  EBAY_APP_ID?: string;
  FB_MCP_URL?: string;
  FB_MCP_TOKEN?: string;
  FB_DEFAULT_LOCATIONS?: string;
}
