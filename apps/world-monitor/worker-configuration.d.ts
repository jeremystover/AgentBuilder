export interface Env {
  AGENT_DO: DurableObjectNamespace;
  AI: Ai;
  ANTHROPIC_API_KEY: string;

  WM_CACHE?: KVNamespace;

  MCP_HTTP_KEY?: string;

  WORLDMONITOR_BASE_URL?: string;
  WORLDMONITOR_API_KEY?: string;
  WORLDMONITOR_TIMEOUT?: string;
  WORLDMONITOR_MAX_RESPONSE_SIZE?: string;
}
