/**
 * lab-chat.ts — POST /api/lab/chat handler.
 *
 * Bridges the kit's runChat tool-loop runtime to a curated set of tools
 * spanning two MCP servers:
 *
 *   - research-agent (this worker): search_semantic, search_fulltext,
 *     synthesize, get_article. Called in-process via the local dispatch.
 *
 *   - chief-of-staff (sibling worker): list_projects, get_project_360.
 *     Called over HTTPS with CHIEF_OF_STAFF_MCP_KEY as the bearer.
 *
 * Streaming is intentionally NOT implemented in V1. The Anthropic
 * tool-use loop is awkward to stream cleanly across multiple iterations;
 * the SPA shows a "Thinking…" placeholder and replaces it with the full
 * reply when it arrives. Wire `messages.stream()` into @agentbuilder/llm
 * later if the latency hurts.
 *
 * Scope-aware system prompt: the SPA passes the current chat scope
 * ("Selected", "Digest", or "Full Corpus") plus optional pinned articles,
 * and we inject a matching preamble so the model knows whether to use
 * the in-context articles or call search_semantic/synthesize.
 */

import type { Env, McpToolDefinition } from "./types";
import { ZodError } from "zod";
import { runChatStream } from "@agentbuilder/web-ui-kit";

import { IngestUrlInput,       ingestUrl }       from "./mcp/tools/ingest_url";
import { SearchSemanticInput,  searchSemantic }  from "./mcp/tools/search_semantic";
import { SearchFulltextInput,  searchFulltext }  from "./mcp/tools/search_fulltext";
import { GetArticleInput,      getArticle }      from "./mcp/tools/get_article";
import { SynthesizeInput,      synthesize }      from "./mcp/tools/synthesize";

// ── Curated tool surface ────────────────────────────────────────────────────
// Keep ≤ ~10 (AGENTS.md rule 2). Research-agent's read-only retrieval
// tools + chief-of-staff's read-only project lookups. Mutations
// (propose_create_task, ingest_url, etc.) are NOT exposed to chat — those
// happen via explicit UI actions (Save as Idea, Promote, etc.) that have
// their own confirmation modals.

const RESEARCH_AGENT_TOOLS: McpToolDefinition[] = [
  {
    name: "search_semantic",
    description: "Vector similarity search over the user's research knowledge base. Use this when the user asks about a topic and you need to find relevant articles by meaning.",
    inputSchema: {
      type: "object", required: ["query"], additionalProperties: false,
      properties: {
        query:     { type: "string", minLength: 1, maxLength: 1000 },
        top_k:     { type: "integer", minimum: 1, maximum: 20, default: 8 },
        min_score: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
      },
    },
  },
  {
    name: "search_fulltext",
    description: "FTS5 keyword search over the user's research. Use this when the user wants exact phrase or boolean term matches.",
    inputSchema: {
      type: "object", required: ["query"], additionalProperties: false,
      properties: {
        query:  { type: "string", minLength: 1, maxLength: 500 },
        limit:  { type: "integer", minimum: 1, maximum: 30, default: 15 },
      },
    },
  },
  {
    name: "get_article",
    description: "Retrieve full article text for an article ID returned by search.",
    inputSchema: {
      type: "object", required: ["article_id"], additionalProperties: false,
      properties: {
        article_id:        { type: "string" },
        include_full_text: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "synthesize",
    description: "RAG: retrieve relevant articles and generate a grounded answer with citations. Prefer this for synthesis questions where you'd otherwise call search_semantic + then summarize.",
    inputSchema: {
      type: "object", required: ["question"], additionalProperties: false,
      properties: {
        question: { type: "string", minLength: 1, maxLength: 1000 },
        top_k:    { type: "integer", minimum: 1, maximum: 12, default: 6 },
      },
    },
  },
];

const CHIEF_OF_STAFF_TOOLS: McpToolDefinition[] = [
  {
    name: "list_projects",
    description: "List the user's active chief-of-staff projects. Use only when the user explicitly asks about their projects or you're suggesting which project an idea belongs in.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { includeClosed: { type: "boolean", default: false } },
    },
  },
  {
    name: "get_project_360",
    description: "Get the 360 view of a specific project: tasks, stakeholders, recent meetings. Use when the user asks for a status check on a named project.",
    inputSchema: {
      type: "object", required: ["projectId"], additionalProperties: false,
      properties: { projectId: { type: "string" } },
    },
  },
];

// ── Tool registry for the kit's runChat ────────────────────────────────────
// The kit expects each tool to have { description, inputSchema, run(args) }.
// run(args) must return an MCP envelope { content: [{ type:"text", text:string }] }.

interface KitTool {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

function envelope(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }] };
}

function buildToolRegistry(env: Env, ctx: ExecutionContext): Record<string, KitTool> {
  const reg: Record<string, KitTool> = {};

  // Research-agent tools — call dispatch directly, in-process.
  reg.search_semantic = {
    description: RESEARCH_AGENT_TOOLS[0]!.description,
    inputSchema: RESEARCH_AGENT_TOOLS[0]!.inputSchema,
    run: async (args) => {
      try { return envelope(await searchSemantic(SearchSemanticInput.parse(args), env)); }
      catch (e) { return envelope({ error: errMsg(e) }); }
    },
  };
  reg.search_fulltext = {
    description: RESEARCH_AGENT_TOOLS[1]!.description,
    inputSchema: RESEARCH_AGENT_TOOLS[1]!.inputSchema,
    run: async (args) => {
      try { return envelope(await searchFulltext(SearchFulltextInput.parse(args), env)); }
      catch (e) { return envelope({ error: errMsg(e) }); }
    },
  };
  reg.get_article = {
    description: RESEARCH_AGENT_TOOLS[2]!.description,
    inputSchema: RESEARCH_AGENT_TOOLS[2]!.inputSchema,
    run: async (args) => {
      try { return envelope(await getArticle(GetArticleInput.parse(args), env)); }
      catch (e) { return envelope({ error: errMsg(e) }); }
    },
  };
  reg.synthesize = {
    description: RESEARCH_AGENT_TOOLS[3]!.description,
    inputSchema: RESEARCH_AGENT_TOOLS[3]!.inputSchema,
    run: async (args) => {
      try { return envelope(await synthesize(SynthesizeInput.parse(args), env)); }
      catch (e) { return envelope({ error: errMsg(e) }); }
    },
  };

  // Chief-of-staff tools — proxied over HTTPS to the CoS /mcp endpoint.
  for (const tool of CHIEF_OF_STAFF_TOOLS) {
    reg[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      run: async (args) => envelope(await callCoSTool(env, tool.name, args)),
    };
  }

  // Suppress unused-var lint while keeping ctx in the signature (some
  // research-agent tools may need it later).
  void ctx;
  return reg;
}

function errMsg(e: unknown): string {
  if (e instanceof ZodError) return "Invalid arguments: " + JSON.stringify(e.flatten().fieldErrors);
  return e instanceof Error ? e.message : String(e);
}

async function callCoSTool(env: Env, name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = env.CHIEF_OF_STAFF_MCP_URL || "https://chief-of-staff.jsstover.workers.dev/mcp";
  const key = env.CHIEF_OF_STAFF_MCP_KEY;
  if (!key) return { error: "CHIEF_OF_STAFF_MCP_KEY not configured" };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: `chief-of-staff ${name} failed: ${res.status} ${text.slice(0, 200)}` };
  }
  const json = (await res.json()) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
  if (json.error) return { error: `chief-of-staff ${name}: ${json.error.message}` };
  const text = json.result?.content?.[0]?.text;
  if (typeof text !== "string") return json.result;
  try { return JSON.parse(text); } catch { return text; }
}

// ── System prompt builder ───────────────────────────────────────────────────

interface PinnedArticle { id: string; title: string; summary: string | null; source_id?: string | null }
type Scope = "selected" | "digest" | "full_corpus";

interface ChatRequestBody {
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: unknown }>;
  scope?: Scope;
  pinned_articles?: PinnedArticle[];
}

function buildSystemPrompt(scope: Scope, pinned: PinnedArticle[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const base = `You are a research and ideas partner. The user has a personal knowledge base of articles they've been tracking via their Research Agent. Your job is to help them synthesize insights, surface connections, and develop ideas.

Today: ${today}

Operating rules:
- Be concise. Bullets > paragraphs. Cite article titles when you reference them.
- When you've synthesized something interesting, end with: "Want to save this as an idea?" — the UI has a 1-click save button.
- Only use the chief-of-staff tools (list_projects, get_project_360) if the user explicitly asks about their projects, or you're recommending which project an idea fits. Do NOT proactively query them.

Scope: ${scope.toUpperCase()}`;

  if (scope === "selected" || scope === "digest") {
    if (pinned.length === 0) {
      return base + "\n\nThe user's selection is empty. Ask them to pin some articles or switch to Full Corpus scope.";
    }
    const lines = pinned.map((a) => `- [${a.title || "(untitled)"}]${a.source_id ? ` (${a.source_id})` : ""}: ${a.summary || ""}`.trim());
    return base + "\n\nArticles in scope:\n" + lines.join("\n") + "\n\nIf you need more context than the summaries, call get_article with the article id.";
  }

  return base + "\n\nUse search_semantic, search_fulltext, or synthesize to retrieve relevant articles in response to the user's questions. Always cite article titles when you reference them.";
}

// ── Allowlist per scope ─────────────────────────────────────────────────────
// In Selected/Digest scope the model gets context inline so it doesn't
// strictly need search tools — but we expose them anyway so it can dig
// deeper if the user asks. Full Corpus mode requires them.

const TOOL_ALLOWLIST = [
  "search_semantic",
  "search_fulltext",
  "get_article",
  "synthesize",
  "list_projects",
  "get_project_360",
];

// ── Handler ─────────────────────────────────────────────────────────────────

export async function handleLabChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), {
      status: 503, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  let body: ChatRequestBody;
  try { body = (await request.json()) as ChatRequestBody; }
  catch { return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } }); }

  const message = String(body?.message ?? "").trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const scope: Scope = body.scope ?? "full_corpus";
  const pinned = Array.isArray(body.pinned_articles) ? body.pinned_articles : [];
  const tools = buildToolRegistry(env, ctx);
  const system = buildSystemPrompt(scope, pinned);

  try {
    const sseStream = await runChatStream({
      ctx: { tools, env: env as unknown as Record<string, unknown> & { ANTHROPIC_API_KEY?: string } },
      body: { message, history: body.history || [], pageContext: { scope } },
      toolAllowlist: TOOL_ALLOWLIST,
      system,
      tier: "default",
      maxIterations: 8,
    });
    return new Response(sseStream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        // Prevent Cloudflare proxies from buffering — streaming would
        // appear chunky or arrive all at once otherwise.
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("ANTHROPIC_API_KEY") ? 503 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
