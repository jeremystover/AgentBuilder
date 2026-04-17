/**
 * ChatSession Durable Object
 *
 * Manages one conversation session. Each request to POST /message:
 *   1. Stores the user message in DO storage
 *   2. Runs the LLM with the full conversation history + available tools
 *   3. If the LLM requests tool calls, executes them and feeds results back
 *   4. Returns the final assistant message
 *
 * Tool loop supports: synthesize, search_semantic, search_fulltext,
 * get_article, ingest_url, generate_digest, record_feedback,
 * manage_interests, list_sources
 */

import type { Env } from "../types";
import { ingestUrl }       from "../mcp/tools/ingest_url";
import { searchSemantic }  from "../mcp/tools/search_semantic";
import { searchFulltext }  from "../mcp/tools/search_fulltext";
import { getArticle }      from "../mcp/tools/get_article";
import { synthesize }      from "../mcp/tools/synthesize";
import { generateDigest }  from "../mcp/tools/generate_digest";
import { recordFeedback }  from "../mcp/tools/record_feedback";
import { manageInterests } from "../mcp/tools/manage_interests";
import { listSources }     from "../mcp/tools/list_sources";
import { scoreContent }    from "../mcp/tools/score_content";
import { IngestUrlInput }      from "../mcp/tools/ingest_url";
import { SearchSemanticInput } from "../mcp/tools/search_semantic";
import { SearchFulltextInput } from "../mcp/tools/search_fulltext";
import { GetArticleInput }     from "../mcp/tools/get_article";
import { SynthesizeInput }     from "../mcp/tools/synthesize";
import { GenerateDigestInput }  from "../mcp/tools/generate_digest";
import { RecordFeedbackInput }  from "../mcp/tools/record_feedback";
import { ManageInterestsInput } from "../mcp/tools/manage_interests";
import { ListSourcesInput }     from "../mcp/tools/list_sources";
import { ScoreContentInput }    from "../mcp/tools/score_content";
import { manageCategories }     from "../mcp/tools/manage_categories";
import { tagContent }           from "../mcp/tools/tag_content";
import { uploadFile }           from "../mcp/tools/upload_file";
import { cleanup }              from "../mcp/tools/cleanup";
import { ManageCategoriesInput } from "../mcp/tools/manage_categories";
import { TagContentInput }       from "../mcp/tools/tag_content";
import { UploadFileInput }       from "../mcp/tools/upload_file";
import { CleanupInput }          from "../mcp/tools/cleanup";

// ── Message types ─────────────────────────────────────────────

type Role = "user" | "assistant" | "tool";

interface StoredMessage {
  role:        Role;
  content:     string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  created_at:  string;
}

interface ToolCall {
  id:       string;
  name:     string;
  args:     Record<string, unknown>;
}

// Workers AI message format
interface AiMessage {
  role:       "system" | "user" | "assistant";
  content:    string;
}

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Content Brain, Jeremy's personal knowledge and content intelligence assistant.

You have access to Jeremy's curated article library and can help him:
- Find articles he's saved on any topic (use search_semantic for concepts, search_fulltext for exact terms)
- Synthesize insights across multiple articles (use synthesize)
- Get a digest of new interesting content (use generate_digest)
- Save new articles to the library (use ingest_url)
- Manage his reading sources (use list_sources)
- Record when he finds something valuable (use record_feedback with thumbs_up)
- Update his interest profile (use manage_interests)
- Organize articles into research categories (use manage_categories to create/list/update/delete)
- Tag articles with categories (use tag_content to assign, remove, list, or auto-suggest)
- Upload files and images (use upload_file — OCR extracts text from images automatically)
- Clean up the knowledge base (use cleanup to find duplicates, stale content, and orphans)

Communication style:
- Be concise and direct
- When citing articles, include the title and URL
- When answering research questions, use synthesize to ground your answer in Jeremy's actual saved content
- If you can't find relevant content, say so and suggest he ingest some sources

Available tools: search_semantic, search_fulltext, synthesize, get_article, ingest_url,
generate_digest, record_feedback, manage_interests, list_sources, score_content,
manage_categories, tag_content, upload_file, cleanup`;

// ── Tool definitions for the LLM ──────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "search_semantic",
    description: "Search Jeremy's knowledge base using natural language. Use for concept/topic searches.",
    parameters: {
      type: "object", required: ["query"],
      properties: {
        query:     { type: "string" },
        top_k:     { type: "number" },
        min_score: { type: "number" },
      },
    },
  },
  {
    name: "search_fulltext",
    description: "Keyword search over saved articles. Use for exact terms, author names, or FTS5 operators.",
    parameters: {
      type: "object", required: ["query"],
      properties: {
        query:  { type: "string" },
        limit:  { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "synthesize",
    description: "Retrieve relevant articles and synthesize a grounded answer with citations.",
    parameters: {
      type: "object", required: ["question"],
      properties: {
        question:         { type: "string" },
        top_k:            { type: "number" },
        include_fulltext: { type: "boolean" },
        style:            { type: "string", enum: ["concise", "detailed", "bullets"] },
      },
    },
  },
  {
    name: "get_article",
    description: "Retrieve full article metadata and optionally the body text by article ID.",
    parameters: {
      type: "object", required: ["article_id"],
      properties: {
        article_id:        { type: "string" },
        include_full_text: { type: "boolean" },
      },
    },
  },
  {
    name: "ingest_url",
    description: "Save a URL to the knowledge base. Extracts content, generates summary, and embeds it.",
    parameters: {
      type: "object", required: ["url"],
      properties: {
        url:  { type: "string" },
        note: { type: "string" },
      },
    },
  },
  {
    name: "generate_digest",
    description: "Generate an on-demand digest of recent articles ranked by relevance to Jeremy's interests.",
    parameters: {
      type: "object",
      properties: {
        limit:     { type: "number" },
        since:     { type: "string" },
        topic:     { type: "string" },
        min_score: { type: "number" },
      },
    },
  },
  {
    name: "record_feedback",
    description: "Record a thumbs-up on an article. Updates interest profile weights.",
    parameters: {
      type: "object", required: ["article_id", "signal"],
      properties: {
        article_id: { type: "string" },
        signal:     { type: "string", enum: ["thumbs_up"] },
        note:       { type: "string" },
      },
    },
  },
  {
    name: "manage_interests",
    description: "View or edit the interest profile (topic weights, source scores, settings).",
    parameters: {
      type: "object", required: ["action"],
      properties: {
        action: { type: "string", enum: ["get", "update", "reset"] },
        patch:  { type: "object" },
        scope:  { type: "string", enum: ["topics", "sources", "all"] },
      },
    },
  },
  {
    name: "list_sources",
    description: "List, add, remove, or toggle ingestion sources (Bluesky feeds, RSS, email aliases).",
    parameters: {
      type: "object", required: ["action"],
      properties: {
        action:    { type: "string", enum: ["list", "add", "remove", "toggle"] },
        source:    { type: "object" },
        source_id: { type: "string" },
        enabled:   { type: "boolean" },
      },
    },
  },
  {
    name: "score_content",
    description: "Score a specific article against the current interest profile.",
    parameters: {
      type: "object", required: ["article_id"],
      properties: { article_id: { type: "string" } },
    },
  },
  {
    name: "manage_categories",
    description: "Create, list, update, or delete research categories for organizing content.",
    parameters: {
      type: "object", required: ["action"],
      properties: {
        action:         { type: "string", enum: ["create", "list", "get", "update", "delete"] },
        name:           { type: "string" },
        description:    { type: "string" },
        color:          { type: "string" },
        parent_id:      { type: "string" },
        category_id:    { type: "string" },
        include_counts: { type: "boolean" },
      },
    },
  },
  {
    name: "tag_content",
    description: "Assign, remove, list, or auto-suggest categories for articles.",
    parameters: {
      type: "object", required: ["action"],
      properties: {
        action:       { type: "string", enum: ["assign", "remove", "list", "suggest", "bulk_assign"] },
        article_id:   { type: "string" },
        article_ids:  { type: "array", items: { type: "string" } },
        category_ids: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "upload_file",
    description: "Upload a file (image, PDF, text). Runs OCR on images and auto-creates articles from text content.",
    parameters: {
      type: "object", required: ["content_base64", "filename"],
      properties: {
        content_base64: { type: "string" },
        filename:       { type: "string" },
        mime_type:      { type: "string" },
        article_id:     { type: "string" },
        category_ids:   { type: "array", items: { type: "string" } },
        note:           { type: "string" },
      },
    },
  },
  {
    name: "cleanup",
    description: "Analyze and clean up the knowledge base: delete articles, find duplicates, stale content, and orphans.",
    parameters: {
      type: "object", required: ["action"],
      properties: {
        action:        { type: "string", enum: ["delete_article", "delete_attachment", "analyze", "review", "approve", "reject", "execute"] },
        article_id:    { type: "string" },
        attachment_id: { type: "string" },
        scope:         { type: "string", enum: ["all", "duplicates", "stale", "errors", "orphans", "uncategorized"] },
        batch_id:      { type: "string" },
        ids:           { type: "array", items: { type: "string" } },
      },
    },
  },
] as const;

// ── Tool executor ─────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  switch (name) {
    case "search_semantic":  return searchSemantic(SearchSemanticInput.parse(args), env);
    case "search_fulltext":  return searchFulltext(SearchFulltextInput.parse(args), env);
    case "synthesize":       return synthesize(SynthesizeInput.parse(args), env);
    case "get_article":      return getArticle(GetArticleInput.parse(args), env);
    case "ingest_url":       return ingestUrl(IngestUrlInput.parse(args), env, {} as ExecutionContext);
    case "generate_digest":  return generateDigest(GenerateDigestInput.parse(args), env);
    case "record_feedback":  return recordFeedback(RecordFeedbackInput.parse(args), env);
    case "manage_interests": return manageInterests(ManageInterestsInput.parse(args), env);
    case "list_sources":     return listSources(ListSourcesInput.parse(args), env);
    case "score_content":       return scoreContent(ScoreContentInput.parse(args), env);
    case "manage_categories":  return manageCategories(ManageCategoriesInput.parse(args), env);
    case "tag_content":        return tagContent(TagContentInput.parse(args), env);
    case "upload_file":        return uploadFile(UploadFileInput.parse(args), env);
    case "cleanup":            return cleanup(CleanupInput.parse(args), env);
    default:                   throw new Error(`Unknown tool: ${name}`);
  }
}

// ── LLM call ──────────────────────────────────────────────────

const LLM_MODEL    = "@cf/meta/llama-3.1-8b-instruct" as const;
const MAX_TOKENS   = 1024;
const MAX_TOOL_ROUNDS = 5; // guard against infinite loops

/**
 * A simple tool-call extraction heuristic for models that don't
 * natively support structured tool calls via the Workers AI binding.
 *
 * We ask the model to output a JSON block when it wants to call a tool:
 *   <tool_call>{"name":"search_semantic","args":{"query":"..."}}</tool_call>
 *
 * This is a pragmatic approach until Workers AI exposes a native tool-use API.
 */
const TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

interface ParsedToolCall {
  id:   string;
  name: string;
  args: Record<string, unknown>;
}

function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const match of text.matchAll(TOOL_CALL_RE)) {
    try {
      const parsed = JSON.parse(match[1]!) as { name: string; args?: Record<string, unknown> };
      calls.push({ id: crypto.randomUUID().slice(0, 8), name: parsed.name, args: parsed.args ?? {} });
    } catch { /* skip malformed */ }
  }
  return calls;
}

function stripToolCalls(text: string): string {
  return text.replace(TOOL_CALL_RE, "").trim();
}

function buildLlmMessages(history: StoredMessage[]): AiMessage[] {
  const messages: AiMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  // Flatten tool messages into assistant context
  // (Workers AI llama doesn't natively support tool role — embed results in user turn)
  let pendingToolResults = "";

  for (const msg of history) {
    if (msg.role === "tool") {
      pendingToolResults += `\n[Tool result for ${msg.tool_call_id}]: ${msg.content}`;
      continue;
    }

    if (pendingToolResults && msg.role === "user") {
      // Append pending tool results before the next user message
      messages.push({ role: "user", content: `${pendingToolResults.trim()}\n\n${msg.content}` });
      pendingToolResults = "";
      continue;
    }

    if (pendingToolResults && msg.role === "assistant") {
      // Flush tool results as a user message first
      messages.push({ role: "user", content: pendingToolResults.trim() });
      pendingToolResults = "";
    }

    // "tool" role already handled by the continue above — msg.role is "user" | "assistant" here
    messages.push({ role: msg.role, content: msg.content });
  }

  // Flush any remaining tool results
  if (pendingToolResults) {
    messages.push({ role: "user", content: pendingToolResults.trim() });
  }

  return messages;
}

// ── Durable Object ─────────────────────────────────────────────

export class ChatSession implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env:   Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === "/message" && method === "POST") {
      return this.handleMessage(request);
    }
    if (url.pathname === "/history" && method === "GET") {
      return doResp({ history: await this.getHistory() });
    }
    if (url.pathname === "/history" && method === "DELETE") {
      await this.state.storage.deleteAll();
      return doResp({ ok: true });
    }

    return doResp({ error: `Not found: ${method} ${url.pathname}` }, 404);
  }

  // ── Message handler ──────────────────────────────────────────

  private async handleMessage(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await request.json(); }
    catch { return doResp({ error: "Body must be JSON" }, 400); }

    const content = typeof (body as Record<string, unknown>)?.["content"] === "string"
      ? ((body as Record<string, unknown>)["content"] as string).trim()
      : null;

    if (!content) return doResp({ error: "content is required" }, 400);

    // Store user message
    const userMsg: StoredMessage = { role: "user", content, created_at: new Date().toISOString() };
    await this.appendMessage(userMsg);

    // Run LLM + tool loop
    try {
      const reply = await this.runLlmLoop();
      const assistantMsg: StoredMessage = { role: "assistant", content: reply, created_at: new Date().toISOString() };
      await this.appendMessage(assistantMsg);
      return doResp({ message: assistantMsg });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error("[ChatSession] LLM loop error:", e);
      const assistantMsg: StoredMessage = {
        role: "assistant",
        content: `I encountered an error: ${errorMsg}. Please try again.`,
        created_at: new Date().toISOString(),
      };
      await this.appendMessage(assistantMsg);
      return doResp({ message: assistantMsg, error: errorMsg }, 500);
    }
  }

  // ── LLM + tool loop ───────────────────────────────────────────

  private async runLlmLoop(): Promise<string> {
    const history = await this.getHistory();

    const toolSystemNote = `
When you need to call a tool, output EXACTLY this format (and nothing else on that line):
<tool_call>{"name":"tool_name","args":{...}}</tool_call>

Available tools: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}`;

    // Inject tool instructions into system message
    const messages = buildLlmMessages(history);
    if (messages[0]?.role === "system") {
      messages[0] = { role: "system", content: messages[0].content + toolSystemNote };
    }

    let finalResponse = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const llmResp = await this.env.AI.run(LLM_MODEL, {
        messages,
        max_tokens:  MAX_TOKENS,
        temperature: 0.4,
      });

      const raw = llmResp.response.trim();
      const toolCalls = parseToolCalls(raw);

      if (toolCalls.length === 0) {
        // No tool calls — this is the final response
        finalResponse = stripToolCalls(raw);
        break;
      }

      // Execute tools and collect results
      const toolResults: string[] = [];
      for (const call of toolCalls) {
        let result: string;
        try {
          const output = await executeTool(call.name, call.args, this.env);
          result = JSON.stringify(output, null, 2);
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }

        // Persist tool call + result to history
        const toolCallMsg: StoredMessage = {
          role: "assistant",
          content: `<tool_call>{"name":"${call.name}","args":${JSON.stringify(call.args)}}</tool_call>`,
          tool_calls: [call],
          created_at: new Date().toISOString(),
        };
        await this.appendMessage(toolCallMsg);

        const toolResultMsg: StoredMessage = {
          role:         "tool",
          content:      result,
          tool_call_id: call.id,
          created_at:   new Date().toISOString(),
        };
        await this.appendMessage(toolResultMsg);

        toolResults.push(`[${call.name} result]: ${result}`);
      }

      // Feed results back to LLM for next round
      messages.push({
        role:    "assistant",
        content: stripToolCalls(raw),
      });
      messages.push({
        role:    "user",
        content: toolResults.join("\n\n") + "\n\nPlease continue your response based on these results.",
      });
    }

    return finalResponse || "I wasn't able to complete that request. Please try rephrasing.";
  }

  // ── Storage helpers ───────────────────────────────────────────

  private async getHistory(): Promise<StoredMessage[]> {
    const entries = await this.state.storage.list<StoredMessage>({ prefix: "msg:" });
    // Limit context window — take last 40 messages to avoid token overflow
    const all = [...entries.values()];
    return all.slice(-40);
  }

  private async appendMessage(msg: StoredMessage): Promise<void> {
    const ts     = new Date(msg.created_at).getTime().toString().padStart(15, "0");
    const suffix = Math.random().toString(36).slice(2, 6);
    await this.state.storage.put(`msg:${ts}:${suffix}`, msg);
  }
}

// ── Module-level helper ────────────────────────────────────────

function doResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}
