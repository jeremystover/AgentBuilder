/**
 * web-ui-kit/api — small helpers for /api/* handlers.
 *
 * Agent api.js modules use these to:
 *   - Return JSON consistently (`jsonResponse`)
 *   - Read JSON bodies safely (`readJson`)
 *   - Call MCP-style tools via `callTool` and `proposeAndCommit`
 *
 * Why these belong in the kit: every agent that wraps a tool registry as
 * REST has the same envelope-unwrap + propose/commit pattern. Putting it
 * here removes drift across agents and keeps the audit trail uniform.
 *
 * Conceptual shapes (JSDoc — runtime is duck-typed):
 *
 *   MCPToolEnvelope = { content?: [{ type: "text", text: string }] }
 *   MCPTool         = { description?, inputSchema?, run(args): Promise<envelope|unknown> }
 *   MCPToolRegistry = { [name: string]: MCPTool }
 */

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/**
 * Pull the JSON body out of an MCP-style tool result envelope. Falls back
 * to the raw text if it doesn't parse, or to the raw value if there's no
 * envelope at all.
 */
export function unwrap(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class ToolError extends Error {
  constructor(message, toolError) {
    super(message);
    this.toolError = toolError;
  }
}

export async function callTool(tools, name, args = {}) {
  const tool = tools[name];
  if (!tool) throw new ToolError(`Tool not registered: ${name}`);
  const out = await tool.run(args);
  const body = unwrap(out);
  if (body && typeof body === "object" && "error" in body && body.error) {
    throw new ToolError(String(body.error), body);
  }
  return body;
}

/**
 * Two-step propose_X then commit_changeset wrapper. Calls the propose
 * tool, extracts the changesetId, then calls commit_changeset. Returns
 * the commit result.
 *
 * Agents that use the chief-of-staff propose/commit convention should
 * route every UI mutation through this so the audit trail stays whole.
 */
export async function proposeAndCommit(tools, proposeName, proposeArgs) {
  const proposed = await callTool(tools, proposeName, proposeArgs);
  if (!proposed?.changesetId) {
    throw new ToolError(`Tool ${proposeName} did not return a changesetId`);
  }
  return await callTool(tools, "commit_changeset", { changesetId: proposed.changesetId });
}
