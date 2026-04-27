import { useMemo, useState } from "react";
import { Plus, Trash2, Check, RotateCcw, RefreshCw, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Select, Input, Badge, PageHeader, EmptyState } from "../ui";
import { useNotes } from "../../hooks/useNotes";
import type { Note, NoteKind, NoteStatus } from "../../types";

type KindFilter = "all" | NoteKind;
type StatusFilter = "all" | NoteStatus;

export function NotesView() {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const { notes, loading, error, refresh, add, update, remove } = useNotes({
    kind:   kindFilter   === "all" ? undefined : kindFilter,
    status: statusFilter === "all" ? undefined : statusFilter,
  });

  // Inline new-note form state.
  const [draftKind, setDraftKind] = useState<NoteKind>("note");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => {
    const all = notes.length;
    const tasksOpen = notes.filter((n) => n.kind === "task" && n.status === "open").length;
    return { all, tasksOpen };
  }, [notes]);

  const onCreate = async () => {
    const title = draftTitle.trim();
    if (!title) {
      toast.error("Title required");
      return;
    }
    setBusy(true);
    try {
      await add({ kind: draftKind, title, body: draftBody.trim() || undefined });
      setDraftTitle(""); setDraftBody("");
      toast.success(draftKind === "task" ? "Task added" : "Note saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Notes"
        subtitle={
          loading ? "Loading…" :
          `${counts.all} item${counts.all !== 1 ? "s" : ""}${counts.tasksOpen ? ` · ${counts.tasksOpen} open task${counts.tasksOpen !== 1 ? "s" : ""}` : ""}`
        }
        actions={
          <>
            <div>
              <label className="block text-xs text-text-muted mb-1">Kind</label>
              <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as KindFilter)}>
                <option value="all">All</option>
                <option value="note">Notes</option>
                <option value="task">Tasks</option>
              </Select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Status</label>
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="done">Done</option>
              </Select>
            </div>
            <Button onClick={() => void refresh()} title="Refresh">
              <RefreshCw className={"w-4 h-4 " + (loading ? "animate-spin" : "")} />
            </Button>
          </>
        }
      />

      {error && (
        <Card className="p-3 mb-4 border-accent-danger/40 bg-accent-danger/5 text-sm text-accent-danger">{error}</Card>
      )}

      {/* Inline new-note form */}
      <Card className="p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <StickyNote className="w-4 h-4 text-accent-primary" />
          <div className="font-semibold text-text-primary">Capture</div>
        </div>
        <div className="grid grid-cols-12 gap-2 mb-2">
          <div className="col-span-2">
            <Select value={draftKind} onChange={(e) => setDraftKind(e.target.value as NoteKind)} className="w-full">
              <option value="note">Note</option>
              <option value="task">Task</option>
            </Select>
          </div>
          <div className="col-span-10">
            <Input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Title"
              className="w-full"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void onCreate(); }}
            />
          </div>
        </div>
        <textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          placeholder="Body (optional)"
          rows={2}
          className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent-primary"
        />
        <div className="flex justify-end mt-2">
          <Button variant="primary" onClick={() => void onCreate()} disabled={busy || !draftTitle.trim()}>
            <Plus className="w-4 h-4" /> {draftKind === "task" ? "Add task" : "Save note"}
          </Button>
        </div>
      </Card>

      {/* List */}
      {notes.length === 0 ? (
        <Card className="p-6"><EmptyState>No items match these filters yet.</EmptyState></Card>
      ) : (
        <div className="flex flex-col gap-2">
          {notes.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              onUpdate={(patch) => update(n.id, patch).then(() => undefined)}
              onDelete={async () => {
                if (!confirm(`Delete "${n.title}"?`)) return;
                await remove(n.id);
                toast.success("Deleted");
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NoteRow({
  note, onUpdate, onDelete,
}: {
  note: Note;
  onUpdate(patch: { status?: NoteStatus; title?: string; body?: string }): Promise<void>;
  onDelete(): Promise<void>;
}) {
  const isTask = note.kind === "task";
  const isDone = note.status === "done";

  return (
    <Card className={"p-3 " + (isTask && isDone ? "opacity-60" : "")}>
      <div className="flex items-start gap-3">
        {isTask && (
          <button
            onClick={() => void onUpdate({ status: isDone ? "open" : "done" })}
            className={
              "mt-0.5 w-5 h-5 shrink-0 rounded border flex items-center justify-center " +
              (isDone
                ? "bg-accent-success border-accent-success text-white"
                : "border-border-strong hover:border-accent-primary")
            }
            title={isDone ? "Reopen" : "Mark done"}
            aria-label={isDone ? "Reopen task" : "Mark task done"}
          >
            {isDone && <Check className="w-3.5 h-3.5" />}
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <Badge tone={isTask ? "info" : "neutral"}>{note.kind}</Badge>
            {isTask && <Badge tone={isDone ? "ok" : "warn"}>{note.status}</Badge>}
            {note.tax_year && <Badge tone="neutral">tax {note.tax_year}</Badge>}
            <span className="text-xs text-text-subtle">{note.created_at.slice(0, 10)}</span>
          </div>
          <div className={"font-medium text-text-primary mt-1 " + (isTask && isDone ? "line-through" : "")}>
            {note.title}
          </div>
          {note.body && (
            <div className="text-sm text-text-muted mt-1 whitespace-pre-wrap">{note.body}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isTask && isDone && (
            <Button size="sm" variant="ghost" onClick={() => void onUpdate({ status: "open" })} title="Reopen">
              <RotateCcw className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void onDelete()} title="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
