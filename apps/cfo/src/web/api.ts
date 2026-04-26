// Fetch wrappers for /api/web/*. Same-origin so the cookie set by /login
// authorises every call. 401 → bounce to /login.

import type { ChatMessage, ChatStreamEvent, Snapshot } from "./types";

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
    location.href = "/login";
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

export async function getSnapshot(): Promise<Snapshot> {
  return request<Snapshot>("/api/web/snapshot");
}

// ── Chat (SSE) ────────────────────────────────────────────────────────────

export interface ChatStreamInput {
  message: string;
  history: ChatMessage[];
}

export async function sendChatStream(
  input: ChatStreamInput,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/web/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(input),
    credentials: "same-origin",
    signal,
  });
  if (res.status === 401) {
    location.href = "/login";
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
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
