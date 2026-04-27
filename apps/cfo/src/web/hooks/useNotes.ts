import { useCallback, useEffect, useState } from "react";
import { listNotes, createNote, updateNote, deleteNote } from "../api";
import type { Note, NoteKind, NoteStatus, CreateNoteInput, UpdateNoteInput } from "../types";

export interface UseNotesResult {
  notes: Note[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  add(input: CreateNoteInput): Promise<Note>;
  update(id: string, patch: UpdateNoteInput): Promise<Note>;
  remove(id: string): Promise<void>;
}

export interface UseNotesOptions {
  kind?: NoteKind;
  status?: NoteStatus;
}

export function useNotes(opts: UseNotesOptions = {}): UseNotesResult {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listNotes({ kind: opts.kind, status: opts.status });
      setNotes(r.notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [opts.kind, opts.status]);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback(async (input: CreateNoteInput) => {
    const r = await createNote(input);
    setNotes((prev) => [r.note, ...prev]);
    return r.note;
  }, []);

  const update = useCallback(async (id: string, patch: UpdateNoteInput) => {
    const r = await updateNote(id, patch);
    setNotes((prev) => prev.map((n) => (n.id === id ? r.note : n)));
    return r.note;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteNote(id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return { notes, loading, error, refresh, add, update, remove };
}
