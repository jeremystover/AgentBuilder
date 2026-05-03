import { useCallback, useEffect, useState } from "react";
import { listSessions, updateSession, archiveSession, deleteSession } from "../api";
import type { ChatSession } from "../types";

/**
 * Manages the chat-sessions sidebar list. The chat itself owns its session
 * id and persistence — this hook is just the index.
 *
 * The list is sorted server-side by `last_message_at` desc, so the most
 * recent conversation always sits on top. New sessions are reflected here
 * automatically when the chat hook reports a `session` SSE event — the
 * App component triggers `refresh()` on that signal so the brand-new
 * session shows up in the list immediately.
 */
export interface UseChatSessionsResult {
  sessions: ChatSession[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  setTags(id: string, tags: string[]): Promise<void>;
  setNotes(id: string, notes: string): Promise<void>;
  archive(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function useChatSessions(): UseChatSessionsResult {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await listSessions(false));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const rename = useCallback(async (id: string, title: string) => {
    const updated = await updateSession(id, { title });
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }, []);

  const setTags = useCallback(async (id: string, tags: string[]) => {
    const updated = await updateSession(id, { tags });
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }, []);

  const setNotes = useCallback(async (id: string, notes: string) => {
    const updated = await updateSession(id, { notes });
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }, []);

  const archive = useCallback(async (id: string) => {
    await archiveSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { sessions, loading, error, refresh, rename, setTags, setNotes, archive, remove };
}
