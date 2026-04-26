import { useEffect, useState } from "react";
import { X, ArrowUpRight, Trash2, Save } from "lucide-react";
import { toast } from "sonner";
import { NoteSection } from "./NoteSection";
import type { ChatTurn, Idea, IdeaStatus } from "../types";

interface Props {
  idea: Idea;
  onClose: () => void;
  onUpdate: (patch: Partial<Pick<Idea, "title" | "body" | "status" | "tags" | "linked_article_ids">>) => Promise<void>;
  onDelete: () => Promise<void>;
  onPromote: () => void;
}

const STATUSES: IdeaStatus[] = ["spark", "developing", "ready", "promoted"];

export function IdeaDrawer({ idea, onClose, onUpdate, onDelete, onPromote }: Props) {
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body);
  const [tags, setTags] = useState(idea.tags.join(", "));
  const [status, setStatus] = useState<IdeaStatus>(idea.status);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(idea.title);
    setBody(idea.body);
    setTags(idea.tags.join(", "));
    setStatus(idea.status);
  }, [idea]);

  const dirty =
    title !== idea.title || body !== idea.body || tags !== idea.tags.join(", ") || status !== idea.status;

  const save = async () => {
    setSaving(true);
    try {
      await onUpdate({
        title,
        body,
        status,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      toast.success("Saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        className="absolute inset-0 bg-bg-primary/60 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close drawer"
      />
      <div className="relative w-full max-w-md h-full bg-bg-surface border-l border-border overflow-y-auto scrollbar-thin">
        <div className="sticky top-0 z-10 bg-bg-surface border-b border-border px-5 py-3 flex items-center justify-between">
          <span className="font-display text-xs uppercase tracking-widest text-text-muted">Idea</span>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-transparent text-xl font-display tracking-wide text-text-primary border-b border-border focus:border-accent-primary focus:outline-none py-1"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as IdeaStatus)}
              className="bg-bg-elevated border border-border rounded px-2 py-1 text-xs text-text-primary"
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="tags (comma-separated)"
              className="flex-1 bg-bg-elevated border border-border rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-muted"
            />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            className="w-full bg-bg-elevated border border-border rounded p-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
            placeholder="Body…"
          />
          {idea.linked_article_ids.length > 0 && (
            <div>
              <div className="font-display text-[10px] uppercase tracking-widest text-text-muted mb-1.5">
                Linked articles
              </div>
              <div className="space-y-1">
                {idea.linked_article_ids.map((aid) => (
                  <div key={aid} className="text-xs text-text-muted font-mono">
                    {aid}
                  </div>
                ))}
              </div>
            </div>
          )}
          {idea.chat_thread.length > 0 && (
            <div>
              <div className="font-display text-[10px] uppercase tracking-widest text-text-muted mb-1.5">
                Chat thread
              </div>
              <div className="space-y-2">
                {idea.chat_thread.map((t: ChatTurn, i) => (
                  <div key={i} className="text-xs">
                    <div className="text-text-muted uppercase tracking-wide font-display text-[10px] mb-0.5">{t.role}</div>
                    <div className="text-text-primary whitespace-pre-wrap leading-relaxed">{t.content}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {idea.promoted_to && (
            <div className="rounded border border-accent-promoted/40 bg-accent-promoted/10 p-3 text-xs text-text-primary">
              Promoted to <span className="font-medium">{idea.promoted_to.project_name}</span>
              {idea.promoted_to.task_key && <> as task <code className="text-text-muted">{idea.promoted_to.task_key}</code></>}
            </div>
          )}
          <NoteSection target={{ kind: "idea", id: idea.id }} />
        </div>
        <div className="sticky bottom-0 bg-bg-surface border-t border-border px-5 py-3 flex items-center gap-2">
          <button
            onClick={async () => {
              if (!confirm("Delete this idea?")) return;
              try { await onDelete(); toast.success("Deleted"); }
              catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
            }}
            className="text-text-muted hover:text-rose-400 inline-flex items-center gap-1 text-xs"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
          {idea.status !== "promoted" && (
            <button
              onClick={onPromote}
              className="ml-auto text-accent-promoted hover:text-violet-300 inline-flex items-center gap-1 text-xs"
            >
              <ArrowUpRight className="w-3.5 h-3.5" /> Promote
            </button>
          )}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded bg-accent-primary text-white px-3 py-1.5 text-xs disabled:opacity-40 inline-flex items-center gap-1 hover:bg-indigo-500 transition-colors"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
