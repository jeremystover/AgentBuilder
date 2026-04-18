import type {
  D1Database,
  R2Bucket,
  VectorizeIndex,
} from "@cloudflare/workers-types";

// Cloudflare Email Workers outbound binding. Used with a `[[send_email]]`
// binding in wrangler.toml; the argument is an `EmailMessage` instance from
// `cloudflare:email`. Typed loosely to avoid version coupling.
export interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}

// ── Workers AI ─────────────────────────────────────────────────

export type AiTextGenerationModel =
  | "@cf/meta/llama-3.1-8b-instruct"
  | "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  | (string & {});

export type AiEmbeddingModel =
  | "@cf/baai/bge-base-en-v1.5"
  | (string & {});

export interface AiTextGenerationInput {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: false;
}

export interface AiTextGenerationOutput {
  response: string;
}

export interface AiEmbeddingInput {
  text: string[];
}

export interface AiEmbeddingOutput {
  data: number[][];
  shape: number[];
}

export interface Ai {
  run(model: AiTextGenerationModel, input: AiTextGenerationInput): Promise<AiTextGenerationOutput>;
  run(model: AiEmbeddingModel, input: AiEmbeddingInput): Promise<AiEmbeddingOutput>;
  run(model: string, input: unknown): Promise<unknown>;
}

// ── Durable Object ─────────────────────────────────────────────

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
  newUniqueId(): DurableObjectId;
}

export interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

// ── Env ────────────────────────────────────────────────────────

export interface Env {
  CONTENT_DB:      D1Database;
  CONTENT_VECTORS: VectorizeIndex;
  CONTENT_STORE:   R2Bucket;
  AI:              Ai;
  CHAT_SESSION:    DurableObjectNamespace;
  SEND_EMAIL?:     SendEmailBinding;

  // Secrets
  MCP_BEARER_TOKEN:     string;
  BLUESKY_IDENTIFIER:   string;
  BLUESKY_APP_PASSWORD: string;
  ENVIRONMENT:          string;
  WATCH_NOTIFY_FROM?:   string;
}

// ── MCP protocol types ─────────────────────────────────────────

export interface McpToolDefinition {
  name:        string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpRequest {
  jsonrpc: "2.0";
  id:      string | number;
  method:  string;
  params?: unknown;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id:      string | number | null;
  result?: unknown;
  error?:  { code: number; message: string; data?: unknown };
}

export interface McpToolCallParams {
  name:      string;
  arguments: Record<string, unknown>;
}

export interface ToolError {
  status: "error";
  error:  string;
}

export type ToolResult<T> = T | ToolError;
