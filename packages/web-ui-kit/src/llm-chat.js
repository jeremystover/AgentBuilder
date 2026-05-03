/**
 * web-ui-kit/llm-chat — Claude-driven chat sidebar runtime.
 *
 * Wraps @agentbuilder/llm's runToolLoop with the conventions every agent's
 * web UI uses:
 *
 *   - Tool definitions are derived from an MCPToolRegistry (the same shape
 *     /mcp uses), filtered by an allowlist so the model picks from a
 *     curated surface (AGENTS.md rule 2).
 *   - Tool handlers unwrap the MCP envelope automatically — the model gets
 *     the JSON-as-text the way it expects.
 *   - System prompt is supplied per-call so each agent can frame its own
 *     persona while sharing this runtime.
 *
 * The @agentbuilder/llm import is dynamic so consumer tests can import this
 * file under raw Node ESM without resolving the LLM package's TS entry.
 *
 * Conceptual shapes:
 *   ChatContext      = { tools, env: { ANTHROPIC_API_KEY?, ... } }
 *   ChatRequestBody  = { message, history?, pageContext? }
 *   RunChatOptions   = { ctx, body, toolAllowlist, system, tier?, maxIterations? }
 *   RunChatResult    = { reply, messages, iterations, usage, stopReason }
 */

async function loadLlm() {
  return await import("@agentbuilder/llm");
}

function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  if (schema.type !== "object") return { type: "object", properties: {}, additionalProperties: false };
  return schema;
}

function buildToolDefs(tools, allowlist) {
  const defs = [];
  const handlers = {};
  for (const name of allowlist) {
    const tool = tools[name];
    if (!tool) continue;
    defs.push({
      name,
      description: String(tool.description || "").slice(0, 1024),
      inputSchema: normalizeInputSchema(tool.inputSchema),
    });
    handlers[name] = async (input) => {
      const result = await tool.run(input || {});
      const text = result?.content?.[0]?.text;
      return typeof text === "string" ? text : JSON.stringify(result);
    };
  }
  return { defs, handlers };
}

export async function runChat(opts) {
  const { ctx, body, toolAllowlist, system, tier = "default", maxIterations = 10 } = opts;
  if (!ctx.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const message = String(body?.message ?? "").trim();
  if (!message) throw new Error("message is required");
  const history = Array.isArray(body?.history) ? body.history : [];

  const { LLMClient, runToolLoop } = await loadLlm();
  const llm = new LLMClient({ anthropicApiKey: ctx.env.ANTHROPIC_API_KEY });
  const { defs, handlers } = buildToolDefs(ctx.tools, toolAllowlist);

  const pageHint = body?.pageContext
    ? `\n\nUser context: ${JSON.stringify(body.pageContext).slice(0, 400)}`
    : "";

  const result = await runToolLoop({
    llm,
    tier,
    system: system + pageHint,
    initialMessages: [...history, { role: "user", content: message }],
    tools: defs,
    handlers,
    maxIterations,
  });

  return {
    reply: result.text,
    messages: result.messages,
    iterations: result.iterations,
    usage: result.usage,
    stopReason: result.stopReason,
  };
}

/**
 * Convenience wrapper for the standard /api/chat route. Returns a Response
 * directly so worker.js can do:
 *
 *   if (path === "/api/chat" && method === "POST") {
 *     return await chatHandler(request, ctx, { toolAllowlist, system });
 *   }
 */
export async function chatHandler(request, ctx, cfg) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  try {
    const result = await runChat({ ctx, body, ...cfg });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("ANTHROPIC_API_KEY") ? 503 : msg.includes("required") ? 400 : 500;
    return jsonError(msg, status);
  }
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ── SSE streaming variant ─────────────────────────────────────────────────
//
// runChatStream / chatStreamHandler — same shape as runChat / chatHandler
// but emits server-sent events so the SPA can render Claude's reply
// progressively (text deltas, tool_use, tool_result).
//
// SSE event format:
//   data: {"type":"text_delta","text":"..."}\n\n
//   data: {"type":"tool_use","toolUseId":"...","toolName":"...","toolInput":{...}}\n\n
//   data: {"type":"tool_result","toolUseId":"...","content":"..."}\n\n
//   data: {"type":"iteration_end","stopReason":"tool_use","hasToolCalls":true}\n\n
//   data: {"type":"done","text":"final reply","stopReason":"end_turn","iterations":2,
//          "messages":[...],"usage":{...}}\n\n
//
// The "done" event carries the canonical assistant message history so the
// SPA can replay it back to the API on the next turn (preserves tool_use /
// tool_result blocks, which the model needs to reason coherently).

export async function runChatStream(opts) {
  const { ctx, body, toolAllowlist, system, tier = "default", maxIterations = 10 } = opts;
  if (!ctx.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const message = String(body?.message ?? "").trim();
  if (!message) throw new Error("message is required");
  const history = Array.isArray(body?.history) ? body.history : [];

  const { LLMClient, runToolLoopStream } = await loadLlm();
  const llm = new LLMClient({ anthropicApiKey: ctx.env.ANTHROPIC_API_KEY });
  const { defs, handlers } = buildToolDefs(ctx.tools, toolAllowlist);

  const pageHint = body?.pageContext
    ? `\n\nUser context: ${JSON.stringify(body.pageContext).slice(0, 400)}`
    : "";

  // ReadableStream that the worker returns to the client. The tool-loop
  // calls onEvent to push frames; we serialize each as an SSE record.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      // Run the loop. Errors are surfaced as a final SSE 'error' frame so
      // the client can render them inline rather than seeing a connection
      // drop.
      (async () => {
        try {
          const result = await runToolLoopStream({
            llm,
            tier,
            system: system + pageHint,
            initialMessages: [...history, { role: "user", content: message }],
            tools: defs,
            handlers,
            maxIterations,
            // Forward every event from the loop verbatim. We DON'T augment
            // the "done" event with messages/usage here even though it
            // would be tempting — `result` is the awaited return of this
            // exact call, so it's in the temporal dead zone for the
            // duration of the callback. Reading it throws "Cannot access
            // 'result' before initialization", which kills the SSE stream
            // mid-flight and (worse) prevents the canonical message
            // history from ever reaching the client. Without that, every
            // subsequent send starts fresh and the chat appears to lose
            // context. The "history" frame sent below — outside the
            // callback, after `result` is initialized — carries the
            // canonical messages array.
            onEvent: (event) => { send(event); },
          });
          // Canonical history frame — emitted AFTER the loop resolves so
          // we can safely read result.messages / result.usage. The SPA's
          // useChat hook listens for this and updates its messages state.
          send({
            type: "history",
            messages: result.messages,
            usage: result.usage,
            iterations: result.iterations,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          send({ type: "error", message: msg });
        } finally {
          controller.close();
        }
      })();
    },
  });

  return stream;
}

export async function chatStreamHandler(request, ctx, cfg) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  try {
    const stream = await runChatStream({ ctx, body, ...cfg });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        // Prevent Cloudflare or upstream proxies from buffering the stream.
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes("ANTHROPIC_API_KEY") ? 503 : msg.includes("required") ? 400 : 500;
    return jsonError(msg, status);
  }
}
