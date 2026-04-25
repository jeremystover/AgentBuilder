/**
 * @agentbuilder/web-ui-kit
 *
 * Shared building blocks for agent web UIs. Goal: every agent that grows
 * a /app surface uses the same look (paper background, serif headings,
 * sans body, indigo accent), the same auth (cookie session + bearer key),
 * the same SPA shell, and the same chat sidebar runtime.
 *
 * Per-agent code (api routes, page renderers, chat tool allowlist) lives
 * in the agent's own apps/<id>/src/web/ — see the chief-of-staff
 * implementation for a worked reference.
 */

export {
  createSession,
  destroySession,
  readSessionFromRequest,
  setSessionCookieHeader,
  clearSessionCookieHeader,
  requireWebSession,
  requireApiAuth,
  verifyPassword,
  WEB_AUTH_CONST,
} from "./auth.js";

export { loginHtml, appHtml } from "./html.js";

export { SPA_CORE_JS } from "./spa-core.js";

export {
  jsonResponse,
  readJson,
  unwrap,
  callTool,
  proposeAndCommit,
  ToolError,
} from "./api.js";

export { runChat, chatHandler } from "./llm-chat.js";

export { WEB_SESSIONS_SQL, BRIEFS_SQL } from "./migrations.js";
