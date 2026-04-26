import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { NoteTargetKind } from "../types";

interface Initial {
  title?: string;
  body?: string;
  linked_article_ids?: string[];
  source_session_id?: string;
  /** Pre-attach to a specific idea or article. Omit for a standalone note. */
  target?: { kind: NoteTargetKind; id: string };
}

interface Props {
  initial: Initial;
  onClose: () => void;
  onCreate: (input: {
    title: string;
    body: string;
    tags: string[];
    target_kind?: NoteTargetKind;
    target_id?: string;
    source_session_id?: string;
    linked_article_ids: string[];
  }) => Promise<void>;
}

export function NewNoteModal({ initial, onClose, onCreate }: Props) {
  const [title, setTitle] = useState(initial.title ?? "");
  const [body, setBody] = useState(initial.body ?? "");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!body.trim() && !title.trim()) {
      toast.error("Add a title or body");
      return;
    }
    setSaving(true);
    try {
      await onCreate({
        title: title.trim(),
        body,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        target_kind: initial.target?.kind,
        target_id: initial.target?.id,
        source_session_id: initial.source_session_id,
        linked_article_ids: initial.linked_article_ids ?? [],
      });
      toast.success("Note saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg-primary/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-bg-surface border border-border rounded-lg shadow-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-display tracking-wide text-lg">New note</Dialog.Title>
            <Dialog.Close className="text-text-muted hover:text-text-primary">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
          />
          <textarea
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What's worth remembering?"
            className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tags (comma-separated)"
            className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
          />
          {initial.target && (
            <div className="text-xs text-text-muted">
              Attaching to {initial.target.kind} <code className="text-[11px]">{initial.target.id.slice(0, 12)}</code>
            </div>
          )}
          {!initial.target && initial.linked_article_ids && initial.linked_article_ids.length > 0 && (
            <div className="text-xs text-text-muted">
              Linking {initial.linked_article_ids.length} article{initial.linked_article_ids.length === 1 ? "" : "s"} from current scope.
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary">Cancel</button>
            <button
              onClick={submit}
              disabled={saving}
              className="rounded bg-accent-primary text-white px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-indigo-500 transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
