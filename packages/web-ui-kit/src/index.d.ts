// Type declarations for @agentbuilder/web-ui-kit. The runtime is plain
// JavaScript (so Node ESM consumers and bundlers both resolve it without
// a build step) but TS consumers want type safety. This .d.ts mirrors
// the JS exports.

export interface WebUiAuthEnv {
  DB?: D1Database;
  WEB_UI_PASSWORD?: string;
  EXTERNAL_API_KEY?: string;
}

export interface AuthOk {
  ok: true;
  sessionId?: string;
  source?: "session" | "bearer";
}
export interface AuthFail {
  ok: false;
  response: Response;
}
export type AuthResult = AuthOk | AuthFail;

// ── Auth ────────────────────────────────────────────────────────────────
export function createSession(env: WebUiAuthEnv | Record<string, unknown>): Promise<{ sessionId: string; expiresAt: string }>;
export function destroySession(env: WebUiAuthEnv | Record<string, unknown>, sessionId: string | undefined): Promise<void>;
export function readSessionFromRequest(request: Request, env: WebUiAuthEnv | Record<string, unknown>): Promise<{ sessionId: string } | null>;
export function setSessionCookieHeader(sessionId: string, opts?: { secure: boolean }): string;
export function clearSessionCookieHeader(opts?: { secure: boolean }): string;
export function requireWebSession(
  request: Request,
  env: WebUiAuthEnv | Record<string, unknown>,
  opts?: { mode: "page" | "api"; loginPath?: string },
): Promise<AuthResult>;
export function requireApiAuth(
  request: Request,
  env: WebUiAuthEnv | Record<string, unknown>,
): Promise<AuthResult>;
export function verifyPassword(env: WebUiAuthEnv | Record<string, unknown>, candidate: unknown): boolean;
export const WEB_AUTH_CONST: { COOKIE_NAME: string; SESSION_TTL_MS: number };

// ── HTML shells ─────────────────────────────────────────────────────────
export interface LoginHtmlOpts { title?: string; error?: string; action?: string }
export interface AppHtmlOpts { title?: string }
export function loginHtml(opts?: LoginHtmlOpts): string;
export function appHtml(opts?: AppHtmlOpts): string;

// ── SPA core (the no-build vanilla bundle) ──────────────────────────────
export const SPA_CORE_JS: string;

// ── API helpers ─────────────────────────────────────────────────────────
export interface MCPToolEnvelope {
  content?: Array<{ type: "text"; text: string }>;
}
export interface MCPTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<MCPToolEnvelope | unknown>;
}
export type MCPToolRegistry = Record<string, MCPTool>;

export function jsonResponse(obj: unknown, status?: number): Response;
export function readJson<T = Record<string, unknown>>(request: Request): Promise<T>;
export function unwrap<T = unknown>(result: unknown): T;
export class ToolError extends Error {
  constructor(message: string, toolError?: unknown);
  toolError?: unknown;
}
export function callTool<T = unknown>(
  tools: MCPToolRegistry,
  name: string,
  args?: Record<string, unknown>,
): Promise<T>;
export function proposeAndCommit<T = unknown>(
  tools: MCPToolRegistry,
  proposeName: string,
  proposeArgs: Record<string, unknown>,
): Promise<T>;

// ── Chat ────────────────────────────────────────────────────────────────
export interface ChatContext {
  tools: MCPToolRegistry;
  env: { ANTHROPIC_API_KEY?: string } & Record<string, unknown>;
}
export interface ChatRequestBody {
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: unknown }>;
  pageContext?: Record<string, unknown>;
}
export interface RunChatOptions {
  ctx: ChatContext;
  body: ChatRequestBody;
  toolAllowlist: string[];
  system: string;
  tier?: "fast" | "default" | "deep";
  maxIterations?: number;
}
export interface RunChatResult {
  reply: string;
  messages: unknown[];
  iterations: number;
  usage: unknown;
  stopReason: string;
}
export function runChat(opts: RunChatOptions): Promise<RunChatResult>;
export function chatHandler(
  request: Request,
  ctx: ChatContext,
  cfg: { toolAllowlist: string[]; system: string; tier?: "fast" | "default" | "deep"; maxIterations?: number },
): Promise<Response>;

// ── Streaming (SSE) variant ────────────────────────────────────────────
export interface RunChatStreamOptions extends RunChatOptions {}
export function runChatStream(opts: RunChatStreamOptions): Promise<ReadableStream<Uint8Array>>;
export function chatStreamHandler(
  request: Request,
  ctx: ChatContext,
  cfg: { toolAllowlist: string[]; system: string; tier?: "fast" | "default" | "deep"; maxIterations?: number },
): Promise<Response>;

// ── Migrations ──────────────────────────────────────────────────────────
export const WEB_SESSIONS_SQL: string;
export const BRIEFS_SQL: string;
