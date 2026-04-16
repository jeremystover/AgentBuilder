/**
 * MCP JSON-RPC 2.0 router.
 * Methods: initialize, tools/list, tools/call
 */

import type { Env, McpRequest, McpResponse, McpToolCallParams } from "../types";
import { ZodError }                              from "zod";
import { IngestUrlInput,      ingestUrl }        from "./tools/ingest_url";
import { SearchSemanticInput, searchSemantic }   from "./tools/search_semantic";
import { SearchFulltextInput, searchFulltext }   from "./tools/search_fulltext";
import { GetArticleInput,     getArticle }       from "./tools/get_article";
import { SynthesizeInput,     synthesize }       from "./tools/synthesize";

const TOOL_MANIFESTS = [
  {
    name: "ingest_url",
    description: "Fetch a URL, extract content, summarize, embed, and store in the knowledge base. Idempotent.",
    inputSchema: {
      type: "object", required: ["url"], additionalProperties: false,
      properties: {
        url:            { type: "string", format: "uri" },
        source_id:      { type: "string" },
        force_reingest: { type: "boolean", default: false },
        note:           { type: "string", maxLength: 500 },
      },
    },
  },
  {
    name: "search_semantic",
    description: "Vector similarity search over the knowledge base using natural language.",
    inputSchema: {
      type: "object", required: ["query"], additionalProperties: false,
      properties: {
        query:     { type: "string", minLength: 1, maxLength: 1000 },
        top_k:     { type: "integer", minimum: 1, maximum: 50, default: 10 },
        min_score: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        filter:    { type: "object", additionalProperties: false, properties: { source_id: { type: "string" }, topic: { type: "string" } } },
      },
    },
  },
  {
    name: "search_fulltext",
    description: 'FTS5 keyword search. Supports AND, OR, NOT, and "exact phrase" operators.',
    inputSchema: {
      type: "object", required: ["query"], additionalProperties: false,
      properties: {
        query:  { type: "string", minLength: 1, maxLength: 500 },
        limit:  { type: "integer", minimum: 1, maximum: 50, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
    },
  },
  {
    name: "get_article",
    description: "Retrieve full article metadata by ID. Optionally include body text or HTML.",
    inputSchema: {
      type: "object", required: ["article_id"], additionalProperties: false,
      properties: {
        article_id:        { type: "string", format: "uuid" },
        include_full_text: { type: "boolean", default: false },
        include_html:      { type: "boolean", default: false },
      },
    },
  },
  {
    name: "synthesize",
    description: "RAG: retrieve relevant articles and generate a grounded answer with citations.",
    inputSchema: {
      type: "object", required: ["question"], additionalProperties: false,
      properties: {
        question:         { type: "string", minLength: 1, maxLength: 2000 },
        top_k:            { type: "integer", minimum: 1, maximum: 20, default: 8 },
        min_score:        { type: "number", minimum: 0, maximum: 1, default: 0.45 },
        include_fulltext: { type: "boolean", default: false },
        style:            { type: "string", enum: ["concise", "detailed", "bullets"], default: "concise" },
      },
    },
  },
] as const;

const RPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: "Parse error" },
  INVALID_REQUEST:  { code: -32600, message: "Invalid Request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS:   { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR:   { code: -32603, message: "Internal error" },
  TOOL_NOT_FOUND:   { code: -32000, message: "Tool not found" },
  TOOL_ERROR:       { code: -32001, message: "Tool execution error" },
} as const;

function ok(id: McpRequest["id"], result: unknown): McpResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(id: McpRequest["id"] | null, code: number, message: string, data?: unknown): McpResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

async function dispatchTool(
  toolName: string, args: Record<string, unknown>, env: Env, ctx: ExecutionContext,
): Promise<unknown> {
  switch (toolName) {
    case "ingest_url":      return ingestUrl(IngestUrlInput.parse(args), env, ctx);
    case "search_semantic": return searchSemantic(SearchSemanticInput.parse(args), env);
    case "search_fulltext": return searchFulltext(SearchFulltextInput.parse(args), env);
    case "get_article":     return getArticle(GetArticleInput.parse(args), env);
    case "synthesize":      return synthesize(SynthesizeInput.parse(args), env);
    default:                return null;
  }
}

function mcpResponse(body: McpResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}

export async function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); }
  catch { return mcpResponse(err(null, RPC_ERRORS.PARSE_ERROR.code, RPC_ERRORS.PARSE_ERROR.message)); }

  if (!body || typeof body !== "object" || (body as Record<string, unknown>)["jsonrpc"] !== "2.0" || typeof (body as Record<string, unknown>)["method"] !== "string") {
    return mcpResponse(err((body as Record<string, unknown>)?.["id"] as McpRequest["id"] ?? null, RPC_ERRORS.INVALID_REQUEST.code, RPC_ERRORS.INVALID_REQUEST.message));
  }

  const req = body as McpRequest;
  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      return mcpResponse(ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "research-agent", version: "1.0.0" },
      }));
    }

    if (method === "tools/list") {
      return mcpResponse(ok(id, { tools: TOOL_MANIFESTS }));
    }

    if (method === "tools/call") {
      if (!params || typeof params !== "object") {
        return mcpResponse(err(id, RPC_ERRORS.INVALID_PARAMS.code, "params required for tools/call"));
      }
      const { name: toolName, arguments: toolArgs = {} } = params as McpToolCallParams;
      if (!toolName) return mcpResponse(err(id, RPC_ERRORS.INVALID_PARAMS.code, "tools/call requires params.name"));

      const knownTool = TOOL_MANIFESTS.find((t) => t.name === toolName);
      if (!knownTool) return mcpResponse(err(id, RPC_ERRORS.TOOL_NOT_FOUND.code, `Unknown tool: ${toolName}`));

      let result: unknown;
      try {
        result = await dispatchTool(toolName, toolArgs as Record<string, unknown>, env, ctx);
      } catch (e) {
        if (e instanceof ZodError) {
          return mcpResponse(err(id, RPC_ERRORS.INVALID_PARAMS.code, "Invalid tool arguments", e.flatten().fieldErrors));
        }
        return mcpResponse(err(id, RPC_ERRORS.TOOL_ERROR.code, e instanceof Error ? e.message : String(e)));
      }

      return mcpResponse(ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false }));
    }

    return mcpResponse(err(id, RPC_ERRORS.METHOD_NOT_FOUND.code, `Method not found: ${method}`));
  } catch (e) {
    console.error("[mcp/router] unhandled error:", e);
    return mcpResponse(err(id, RPC_ERRORS.INTERNAL_ERROR.code, e instanceof Error ? e.message : "Unexpected error"));
  }
}
