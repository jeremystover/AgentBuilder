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
  patch: Partial<Pick<Idea, "title" | "body" | "status" | "tags" | "linked_article_ids" | "chat_thread">>,
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

// ── Chat ─────────────────────────────────────────────────────────────────

export interface ChatResponse {
  reply: string;
  messages: ChatMessage[];
  iterations: number;
  usage: unknown;
}

export async function sendChat(input: {
  message: string;
  history: ChatMessage[];
  scope: ChatScope;
  pinned_articles: Array<{ id: string; title: string; summary: string | null; source_id: string | null }>;
}): Promise<ChatResponse> {
  return await request<ChatResponse>("/api/lab/chat", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
