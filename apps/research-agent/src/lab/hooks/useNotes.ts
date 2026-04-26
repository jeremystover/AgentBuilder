import { useCallback, useEffect, useState } from "react";
import { listNotes, createNote, updateNote, deleteNote } from "../api";
import type { Note, NoteTargetKind } from "../types";

/**
 * Notes attached to a specific idea or article. Pass `null` to disable
 * (no fetch — useful when conditionally rendering a section that may not
 * have a target yet).
 *
 * Standalone notes (no target) are out of scope for this hook — they
 * have their own list view. We could add a 'standalone' mode here later
 * by accepting `{ kind: null }`, but for V1 the call sites are all
 * target-attached.
 */
export interface UseNotesResult {
  notes: Note[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  add(input: { title?: string; body?: string; tags?: string[]; linked_article_ids?: string[] }): Promise<Note>;
  update(id: string, patch: Parameters<typeof updateNote>[1]): Promise<Note>;
  remove(id: string): Promise<void>;
}

export function useNotes(target: { kind: NoteTargetKind; id: string } | null): UseNotesResult {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!target) { setNotes([]); return; }
    setLoading(true);
    setError(null);
    try {
      setNotes(await listNotes({ target }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [target?.kind, target?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback(async (input: { title?: string; body?: string; tags?: string[]; linked_article_ids?: string[] }) => {
    if (!target) throw new Error("no target");
    const note = await createNote({
      ...input,
      target_kind: target.kind,
      target_id: target.id,
    });
    setNotes((prev) => [note, ...prev]);
    return note;
  }, [target]);

  const update = useCallback(async (id: string, patch: Parameters<typeof updateNote>[1]) => {
    const updated = await updateNote(id, patch);
    setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)));
    return updated;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteNote(id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return { notes, loading, error, refresh, add, update, remove };
}
