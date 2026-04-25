import { useCallback, useState } from "react";
import { sendChat } from "../api";
import type { Article, ChatMessage, ChatScope, ChatTurn } from "../types";

// Renderable chat turns (text-only). The full Anthropic-shaped history
// (with tool_use / tool_result blocks) lives separately so we can replay
// it back to the API.
interface RenderTurn {
  role: "user" | "assistant";
  content: string;
}

export interface UseChatResult {
  turns: RenderTurn[];
  messages: ChatMessage[];
  loading: boolean;
  send(message: string, scope: ChatScope, pinned: Article[]): Promise<string>;
  clear(): void;
  /** Recent text-only thread for attaching to ideas. */
  recentThread(maxPairs?: number): ChatTurn[];
}

export function useChat(): UseChatResult {
  const [turns, setTurns] = useState<RenderTurn[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const send = useCallback(async (message: string, scope: ChatScope, pinned: Article[]) => {
    const optimisticTurns: RenderTurn[] = [...turns, { role: "user", content: message }];
    setTurns(optimisticTurns);
    setLoading(true);
    try {
      const result = await sendChat({
        message,
        history: messages,
        scope,
        pinned_articles: pinned.map((a) => ({
          id: a.id,
          title: a.title || "(untitled)",
          summary: a.summary,
          source_id: a.source_id,
        })),
      });
      setMessages(result.messages);
      setTurns([...optimisticTurns, { role: "assistant", content: result.reply || "(no reply)" }]);
      return result.reply;
    } finally {
      setLoading(false);
    }
  }, [messages, turns]);

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

  return { turns, messages, loading, send, clear, recentThread };
}
