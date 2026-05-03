import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { IdeaStatus } from "../types";

interface Initial {
  title: string;
  body: string;
  linked_article_ids: string[];
  chat_thread: unknown[];
}

interface Props {
  initial: Initial;
  onClose: () => void;
  onCreate: (input: {
    title: string;
    body: string;
    status: IdeaStatus;
    tags: string[];
    linked_article_ids: string[];
    chat_thread: unknown[];
  }) => Promise<void>;
}

export function NewIdeaModal({ initial, onClose, onCreate }: Props) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim()) {
      toast.error("Title required");
      return;
    }
    setSaving(true);
    try {
      await onCreate({
        title: title.trim(),
        body,
        status: "spark",
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        linked_article_ids: initial.linked_article_ids,
        chat_thread: initial.chat_thread,
      });
      toast.success("Idea saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg-primary/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg bg-bg-surface border border-border rounded-lg shadow-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-display tracking-wide text-lg">New idea</Dialog.Title>
            <Dialog.Close className="text-text-muted hover:text-text-primary">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
          />
          <textarea
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What's the idea? Context, hypothesis, what makes it interesting…"
            className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
          />
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="tags (comma-separated)"
            className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
          />
          {initial.linked_article_ids.length > 0 && (
            <div className="text-xs text-text-muted">
              Linking {initial.linked_article_ids.length} article{initial.linked_article_ids.length === 1 ? "" : "s"} from current scope.
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary"
            >Cancel</button>
            <button
              onClick={submit}
              disabled={saving}
              className="rounded bg-accent-primary text-white px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-indigo-500 transition-colors"
            >{saving ? "Saving…" : "Save"}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
