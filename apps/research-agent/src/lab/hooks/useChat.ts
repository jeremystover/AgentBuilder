import { useCallback, useRef, useState } from "react";
import { sendChatStream, type ChatStreamEvent } from "../api";
import type { Article, ChatMessage, ChatScope, ChatTurn } from "../types";

// ── Renderable turn types ──────────────────────────────────────────────────
// Distinct from the wire ChatMessage shape — these are what the UI
// actually displays. An assistant turn can carry inline tool-use pills
// alongside the streamed text.

export type ToolPillStatus = "running" | "ok" | "error";

export interface ToolPill {
  id: string;          // tool_use_id (matches the pair across use → result)
  name: string;
  status: ToolPillStatus;
}

export type RenderTurn =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; pills: ToolPill[]; streaming: boolean };

export interface UseChatResult {
  turns: RenderTurn[];
  messages: ChatMessage[];
  loading: boolean;
  send(message: string, scope: ChatScope, pinned: Article[]): Promise<string>;
  cancel(): void;
  clear(): void;
  /** Recent text-only thread for attaching to ideas. */
  recentThread(maxPairs?: number): ChatTurn[];
}

let nextId = 0;
function nid(): string { return `t${++nextId}`; }

export function useChat(): UseChatResult {
  const [turns, setTurns] = useState<RenderTurn[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (message: string, scope: ChatScope, pinned: Article[]) => {
    // Append the user turn immediately, plus an empty assistant turn that
    // we'll fill in via stream events.
    const userTurn: RenderTurn = { id: nid(), role: "user", content: message };
    const assistantTurnId = nid();
    const assistantTurn: RenderTurn = {
      id: assistantTurnId,
      role: "assistant",
      content: "",
      pills: [],
      streaming: true,
    };
    setTurns((prev) => [...prev, userTurn, assistantTurn]);

    const updateAssistant = (mut: (t: Extract<RenderTurn, { role: "assistant" }>) => void) => {
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
              // Mid-stream marker; nothing to render. The next iteration's
              // text_deltas will continue filling the same assistant turn.
              break;
            case "history":
              setMessages(event.messages);
              break;
            case "done":
              if (event.text && event.text !== finalText) {
                // Some LLM SDKs emit text only at end-of-stream rather than
                // as deltas. Guarantee the visible content matches the
                // canonical reply.
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
    setTurns([]);
    setMessages([]);
  }, []);

  const recentThread = useCallback((maxPairs = 4): ChatTurn[] => {
    const slice = turns.slice(-maxPairs * 2);
    return slice.map((t) => ({
      role: t.role,
      content: t.content,
      timestamp: new Date().toISOString(),
    }));
  }, [turns]);

  return { turns, messages, loading, send, cancel, clear, recentThread };
}
