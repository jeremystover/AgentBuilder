import { useCallback, useEffect, useRef, useState } from "react";
import { sendChatStream, getSession, type ChatStreamEvent } from "../api";
import type { Article, ChatMessage, ChatScope, ChatTurn, PersistedMessage } from "../types";

// ── Renderable turn types ──────────────────────────────────────────────────
// Distinct from the wire ChatMessage shape — these are what the UI
// actually displays. An assistant turn can carry inline tool-use pills
// alongside the streamed text.

export type ToolPillStatus = "running" | "ok" | "error";

export interface ToolPill {
  id: string;
  name: string;
  status: ToolPillStatus;
}

export type RenderTurn =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; pills: ToolPill[]; streaming: boolean };

export interface UseChatResult {
  /** The session this hook is currently editing. null until first send (when the worker creates one). */
  sessionId: string | null;
  turns: RenderTurn[];
  messages: ChatMessage[];
  loading: boolean;
  /** True while loading persisted messages from the server (e.g. after a session switch). */
  hydrating: boolean;
  send(message: string, scope: ChatScope, pinned: Article[]): Promise<string>;
  cancel(): void;
  clear(): void;
  /** Set the session id (e.g. switching to a different session in the sidebar, or starting fresh with null). */
  setSessionId(id: string | null): void;
  /** Recent text-only thread for attaching to ideas. */
  recentThread(maxPairs?: number): ChatTurn[];
}

let nextLocalId = 0;
function nid(): string { return `t${++nextLocalId}`; }

// Persisted messages from D1 are wire-shaped (Anthropic ChatMessage with
// string OR ContentBlock[] content). For rendering, we want text-only
// turns with no streaming/pill state. This compresses each persisted
// message into a single RenderTurn — tool_use/tool_result blocks from
// prior runs are dropped (the user already saw them as transient pills).
function persistedToRenderTurns(messages: PersistedMessage[]): RenderTurn[] {
  const out: RenderTurn[] = [];
  for (const m of messages) {
    const text = extractText(m.content);
    if (!text && m.role === "user") continue;
    if (m.role === "user") {
      out.push({ id: m.id, role: "user", content: text });
    } else {
      out.push({ id: m.id, role: "assistant", content: text, pills: [], streaming: false });
    }
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && "type" in b)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}

export function useChat(initialSessionId: string | null = null): UseChatResult {
  const [sessionId, setSessionIdState] = useState<string | null>(initialSessionId);
  const [turns, setTurns] = useState<RenderTurn[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Track the active session id for the in-flight fetch so a session
  // switch mid-stream doesn't clobber the new conversation with the old
  // one's deltas.
  const activeSessionRef = useRef<string | null>(initialSessionId);

  // Hydrate persisted messages whenever sessionId changes.
  useEffect(() => {
    activeSessionRef.current = sessionId;
    if (!sessionId) {
      setTurns([]);
      setMessages([]);
      return;
    }
    let cancelled = false;
    setHydrating(true);
    (async () => {
      try {
        const { messages: persisted } = await getSession(sessionId);
        if (cancelled) return;
        // Re-shape for both render and replay paths.
        const renderTurns = persistedToRenderTurns(persisted);
        const wireMessages: ChatMessage[] = persisted.map((m) => ({
          role: m.role,
          // Use the raw stored content so tool_use/tool_result blocks
          // round-trip back to the model on the next turn (model needs
          // them paired or it errors).
          content: m.content as string | unknown[],
        }));
        setTurns(renderTurns);
        setMessages(wireMessages);
      } catch {
        // Session probably doesn't exist (deleted, or the URL ?session=
        // was stale). Fall back to a blank state and let the next send
        // create a new one.
        if (!cancelled) {
          setTurns([]);
          setMessages([]);
          setSessionIdState(null);
        }
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  const setSessionId = useCallback((id: string | null) => {
    // Cancel any in-flight stream from the previous session.
    abortRef.current?.abort();
    setSessionIdState(id);
  }, []);

  const send = useCallback(async (message: string, scope: ChatScope, pinned: Article[]) => {
    const sessionAtSend = activeSessionRef.current;

    const userTurn: RenderTurn = { id: nid(), role: "user", content: message };
    const assistantTurnId = nid();
    const assistantTurn: RenderTurn = { id: assistantTurnId, role: "assistant", content: "", pills: [], streaming: true };
    setTurns((prev) => [...prev, userTurn, assistantTurn]);

    const updateAssistant = (mut: (t: Extract<RenderTurn, { role: "assistant" }>) => void) => {
      // Skip the update if the user has switched sessions — the streamed
      // event no longer applies to what's on screen.
      if (activeSessionRef.current !== sessionAtSend) return;
      setTurns((prev) =>
        prev.map((t) => (t.id === assistantTurnId && t.role === "assistant"
          ? (() => { const next = { ...t, pills: [...t.pills] }; mut(next); return next; })()
          : t)),
      );
    };

    setLoading(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let finalText = "";
    try {
      await sendChatStream(
        {
          session_id: sessionAtSend ?? undefined,
          message,
          history: messages,
          scope,
          pinned_articles: pinned.map((a) => ({
            id: a.id,
            title: a.title || "(untitled)",
            summary: a.summary,
            source_id: a.source_id,
          })),
        },
        (event: ChatStreamEvent) => {
          switch (event.type) {
            case "session":
              // First send — adopt the session id the worker created
              // (or confirmed). Update state + ref so subsequent sends
              // append to the same session.
              if (event.session_id && event.session_id !== sessionAtSend) {
                activeSessionRef.current = event.session_id;
                setSessionIdState(event.session_id);
              }
              break;
            case "text_delta":
              updateAssistant((t) => { t.content += event.text; });
              finalText += event.text;
              break;
            case "tool_use":
              updateAssistant((t) => {
                t.pills.push({ id: event.toolUseId, name: event.toolName, status: "running" });
              });
              break;
            case "tool_result":
              updateAssistant((t) => {
                const pill = t.pills.find((p) => p.id === event.toolUseId);
                if (pill) pill.status = event.isError ? "error" : "ok";
              });
              break;
            case "iteration_end":
              break;
            case "history":
              if (activeSessionRef.current === activeSessionRef.current) {
                setMessages(event.messages);
              }
              break;
            case "done":
              if (event.text && event.text !== finalText) {
                finalText = event.text;
                updateAssistant((t) => { t.content = event.text; });
              }
              if (event.messages) setMessages(event.messages);
              break;
            case "error":
              updateAssistant((t) => { t.content = (t.content ? t.content + "\n\n" : "") + "Error: " + event.message; });
              break;
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        updateAssistant((t) => { t.content = (t.content ? t.content + "\n\n" : "") + "(cancelled)"; });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        updateAssistant((t) => { t.content = (t.content ? t.content + "\n\n" : "") + "Error: " + msg; });
      }
    } finally {
      updateAssistant((t) => { t.streaming = false; });
      setLoading(false);
      abortRef.current = null;
    }
    return finalText;
  }, [messages]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
    setMessages([]);
    activeSessionRef.current = null;
    setSessionIdState(null);
  }, []);

  const recentThread = useCallback((maxPairs = 4): ChatTurn[] => {
    const slice = turns.slice(-maxPairs * 2);
    return slice.map((t) => ({
      role: t.role,
      content: t.content,
      timestamp: new Date().toISOString(),
    }));
  }, [turns]);

  return { sessionId, turns, messages, loading, hydrating, send, cancel, clear, setSessionId, recentThread };
}
