import { useCallback, useRef, useState } from "react";
import { sendChatStream } from "../api";
import { summarizeToolResult } from "../lib/tool-summarize";
import type { ChatMessage, ChatStreamEvent } from "../types";

export type ToolPillStatus = "running" | "ok" | "error";

export interface ToolPill {
  id: string;
  name: string;
  status: ToolPillStatus;
  /** One-line summary of the tool result, populated when tool_result arrives. */
  summary?: string;
}

export type RenderTurn =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; pills: ToolPill[]; streaming: boolean };

export interface UseChatResult {
  turns: RenderTurn[];
  loading: boolean;
  send(message: string): Promise<void>;
  cancel(): void;
  clear(): void;
}

let nextId = 0;
function nid(): string { return `t${++nextId}`; }

export function useChat(): UseChatResult {
  const [turns, setTurns] = useState<RenderTurn[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (message: string) => {
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

    try {
      await sendChatStream(
        { message, history: messages },
        (event: ChatStreamEvent) => {
          switch (event.type) {
            case "text_delta":
              updateAssistant((t) => { t.content += event.text; });
              break;
            case "tool_use":
              updateAssistant((t) => {
                t.pills.push({ id: event.toolUseId, name: event.toolName, status: "running" });
              });
              break;
            case "tool_result":
              updateAssistant((t) => {
                const pill = t.pills.find((p) => p.id === event.toolUseId);
                if (!pill) return;
                pill.status = event.isError ? "error" : "ok";
                // Surface a one-line summary inline so the user sees a
                // tool result the moment it lands, not after the model's
                // reply finishes streaming.
                const summary = summarizeToolResult(pill.name, event.content);
                if (summary) pill.summary = summary;
              });
              break;
            case "history":
              setMessages(event.messages);
              break;
            case "done":
              updateAssistant((t) => { t.streaming = false; });
              if (event.messages) setMessages(event.messages);
              break;
            case "error":
              updateAssistant((t) => {
                t.content += (t.content ? "\n\n" : "") + `⚠ ${event.message}`;
                t.streaming = false;
              });
              break;
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        updateAssistant((t) => { t.streaming = false; });
      } else {
        updateAssistant((t) => {
          t.content += (t.content ? "\n\n" : "") + `⚠ ${(err as Error).message}`;
          t.streaming = false;
        });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [messages]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    setTurns([]);
    setMessages([]);
  }, []);

  return { turns, loading, send, cancel, clear };
}
