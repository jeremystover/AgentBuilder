import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useNotes } from "../hooks/useNotes";
import type { NoteTargetKind } from "../types";

interface Props {
  /** What this section attaches notes to. */
  target: { kind: NoteTargetKind; id: string };
  /** Optional inline header label. Defaults to "Notes". */
  label?: string;
}

/**
 * Inline notes editor: list, add, edit, delete. Used inside the
 * IdeaDrawer and ArticleDrawer side-rail. Each note is title + body —
 * tags are intentionally minimal here; the standalone notes browser
 * (future) is the place for richer note management.
 */
export function NoteSection({ target, label = "Notes" }: Props) {
  const { notes, loading, add, update, remove } = useNotes(target);
  const [composing, setComposing] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="font-display text-[10px] uppercase tracking-widest text-text-muted">
          {label} {notes.length > 0 && <span className="ml-1 opacity-60">{notes.length}</span>}
        </div>
        <button
          onClick={() => setComposing(true)}
          className="text-[11px] text-text-muted hover:text-text-primary inline-flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      <div className="space-y-2">
        {composing && (
          <NoteComposer
            onCancel={() => setComposing(false)}
            onSave={async (title, body) => {
              try {
                await add({ title, body });
                setComposing(false);
              } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
            }}
          />
        )}
        {!loading && notes.length === 0 && !composing && (
          <div className="text-xs text-text-muted italic">No notes yet.</div>
        )}
        {notes.map((n) => (
          <NoteRow
            key={n.id}
            note={n}
            onSave={async (title, body) => {
              try {
                await update(n.id, { title, body });
              } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
            }}
            onDelete={async () => {
              if (!confirm("Delete this note?")) return;
              try { await remove(n.id); }
              catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function NoteRow({
  note, onSave, onDelete,
}: {
  note: { title: string; body: string; updated_at: string };
  onSave: (title: string, body: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);

  if (editing) {
    return (
      <div className="rounded border border-accent-primary/50 bg-bg-elevated p-2 space-y-1.5">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full bg-transparent border-b border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-primary py-1"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none"
        />
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={() => { setTitle(note.title); setBody(note.body); setEditing(false); }}
            className="text-[11px] text-text-muted hover:text-text-primary"
          >Cancel</button>
          <button
            onClick={async () => { await onSave(title, body); setEditing(false); }}
            className="text-[11px] rounded bg-accent-primary text-white px-2 py-0.5 hover:bg-indigo-500"
          >Save</button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      className="group rounded border border-border bg-bg-elevated/50 p-2 cursor-pointer hover:border-accent-primary/40 transition-colors"
    >
      {note.title && <div className="text-sm text-text-primary">{note.title}</div>}
      {note.body && <div className="text-xs text-text-muted whitespace-pre-wrap leading-relaxed mt-1 line-clamp-4">{note.body}</div>}
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-text-muted/70">{new Date(note.updated_at).toLocaleDateString()}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-text-muted/60 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Delete note"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

function NoteComposer({
  onCancel, onSave,
}: { onCancel: () => void; onSave: (title: string, body: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <div className="rounded border border-accent-primary/50 bg-bg-elevated p-2 space-y-1.5">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional)"
        className="w-full bg-transparent border-b border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-primary py-1"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Note body…"
        className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none resize-none"
      />
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="text-[11px] text-text-muted hover:text-text-primary">Cancel</button>
        <button
          onClick={async () => {
            if (!title.trim() && !body.trim()) { toast.error("Add a title or body"); return; }
            await onSave(title.trim(), body);
          }}
          className="text-[11px] rounded bg-accent-primary text-white px-2 py-0.5 hover:bg-indigo-500"
        >Add</button>
      </div>
    </div>
  );
}
