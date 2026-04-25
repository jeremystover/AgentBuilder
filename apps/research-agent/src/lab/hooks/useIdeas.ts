import { useCallback, useEffect, useState } from "react";
import { listIdeas, createIdea, updateIdea, deleteIdea, promoteIdea } from "../api";
import type { Idea, IdeaStatus } from "../types";

export function useIdeas() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setIdeas(await listIdeas());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback(async (input: Parameters<typeof createIdea>[0]) => {
    const idea = await createIdea(input);
    setIdeas((prev) => [idea, ...prev]);
    return idea;
  }, []);

  const update = useCallback(async (id: string, patch: Parameters<typeof updateIdea>[1]) => {
    const idea = await updateIdea(id, patch);
    setIdeas((prev) => prev.map((i) => (i.id === id ? idea : i)));
    return idea;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteIdea(id);
    setIdeas((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const promote = useCallback(async (id: string, body: Parameters<typeof promoteIdea>[1]) => {
    const { idea } = await promoteIdea(id, body);
    setIdeas((prev) => prev.map((i) => (i.id === id ? idea : i)));
    return idea;
  }, []);

  // Optimistic status move (used by drag-and-drop). Falls back on error.
  const setStatus = useCallback(async (id: string, status: IdeaStatus) => {
    setIdeas((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
    try {
      await updateIdea(id, { status });
    } catch (e) {
      // Roll back by refresh.
      void refresh();
      throw e;
    }
  }, [refresh]);

  return { ideas, loading, error, refresh, add, update, remove, promote, setStatus };
}
