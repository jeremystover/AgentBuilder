// fetch wrappers for /api/lab/*. All requests go same-origin so the
// cookie set by /lab/login authorises every call.

import type {
  Idea, Article, Project, ChatScope, ChatMessage, ArticleWindow, IdeaStatus,
} from "./types";

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    location.href = "/lab/login";
    throw new Error("unauthorized");
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "error" in data)
      ? String((data as Record<string, unknown>).error)
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

// ── Ideas ────────────────────────────────────────────────────────────────

export async function listIdeas(): Promise<Idea[]> {
  const data = await request<{ ideas: Idea[] }>("/api/lab/ideas");
  return data.ideas;
}

export async function createIdea(input: {
  title: string;
  body?: string;
  status?: IdeaStatus;
  tags?: string[];
  linked_article_ids?: string[];
  chat_thread?: unknown[];
}): Promise<Idea> {
  const data = await request<{ idea: Idea }>("/api/lab/ideas", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.idea;
}

export async function updateIdea(
  id: string,
  patch: Partial<Pick<Idea, "title" | "body" | "status" | "tags" | "linked_article_ids" | "chat_thread" | "position">>,
): Promise<Idea> {
  const data = await request<{ idea: Idea }>(`/api/lab/ideas/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.idea;
}

export async function deleteIdea(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/lab/ideas/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function promoteIdea(
  id: string,
  body:
    | { mode: "existing"; project_id: string; project_name: string }
    | { mode: "new"; project_name: string; goal?: string; priority?: "high" | "medium" | "low" },
): Promise<{ idea: Idea }> {
  return await request<{ idea: Idea }>(`/api/lab/ideas/${encodeURIComponent(id)}/promote`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Articles ─────────────────────────────────────────────────────────────

export async function listArticles(window: ArticleWindow, limit = 50): Promise<Article[]> {
  const data = await request<{ articles: Article[] }>(
    `/api/lab/articles?window=${window}&limit=${limit}`,
  );
  return data.articles;
}

// ── Projects ─────────────────────────────────────────────────────────────

export async function listProjects(): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/lab/projects");
  return data.projects;
}

// ── Chat (streaming SSE) ─────────────────────────────────────────────────
//
// /api/lab/chat returns a text/event-stream body. We parse it line-by-
// line and dispatch typed events to the caller. The kit guarantees these
// event types:
//
//   text_delta     — append delta to current assistant turn
//   tool_use       — agent invoked a tool (renders as "calling foo…" pill)
//   tool_result    — tool returned (renders as "got result")
//   iteration_end  — current iteration done; another may follow
//   done           — full reply produced; carries final messages + usage
//   history        — terminal frame with the canonical message history
//                    (use this to replay on the next turn)
//   error          — surface to user, do not retry transparently

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; toolUseId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "iteration_end"; stopReason: string; hasToolCalls: boolean }
  | { type: "done"; text: string; stopReason: string; iterations: number; messages?: ChatMessage[]; usage?: unknown }
  | { type: "history"; messages: ChatMessage[]; usage: unknown; iterations: number }
  | { type: "error"; message: string };

export interface ChatStreamInput {
  message: string;
  history: ChatMessage[];
  scope: ChatScope;
  pinned_articles: Array<{ id: string; title: string; summary: string | null; source_id: string | null }>;
}

export async function sendChatStream(
  input: ChatStreamInput,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/lab/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "text/event-stream" },
    body: JSON.stringify(input),
    credentials: "same-origin",
    signal,
  });
  if (res.status === 401) {
    location.href = "/lab/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed?.error) msg = String(parsed.error);
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  if (!res.body) throw new Error("response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE framing: events are separated by blank lines. Each event is a
  // sequence of "field: value" lines; we only care about "data:".
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Process any complete events in the buffer.
    let sepIdx;
    // eslint-disable-next-line no-cond-assign
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      try {
        const parsed = JSON.parse(data) as ChatStreamEvent;
        onEvent(parsed);
      } catch (err) {
        console.warn("malformed SSE frame", err, data);
      }
    }
  }
}
