import { useState } from "react";
import { toast } from "sonner";
import { Button, Input, Select } from "./ui";
import { createNote } from "../api";
import type { NoteKind } from "../types";

interface Props {
  initialTitle: string;
  initialBody: string;
  sourceMessageId?: string;
  onClose(): void;
  onSaved?: () => void;
}

// Lightweight modal — opens from a "Save…" button on an assistant
// reply, pre-populates the body with the reply text and the title with
// the first sentence (or first 80 chars). The user picks note vs task.

export function SaveAsNoteModal({
  initialTitle, initialBody, sourceMessageId, onClose, onSaved,
}: Props) {
  const [kind, setKind] = useState<NoteKind>("note");
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const t = title.trim();
    if (!t) {
      toast.error("Title required");
      return;
    }
    setBusy(true);
    try {
      await createNote({
        kind,
        title: t,
        body: body.trim() || undefined,
        source_chat_message_id: sourceMessageId,
      });
      toast.success(kind === "task" ? "Task added" : "Note saved");
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-bg-surface rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="font-semibold text-text-primary">Save reply</div>
          <button className="text-text-muted hover:text-text-primary" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          <div>
            <label className="block text-xs text-text-muted mb-1">Save as</label>
            <Select value={kind} onChange={(e) => setKind(e.target.value as NoteKind)} className="w-full">
              <option value="note">Note (capture)</option>
              <option value="task">Task (open / done)</option>
            </Select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full" autoFocus />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-primary"
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border bg-bg-elevated flex justify-end gap-2 rounded-b-xl">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !title.trim()}>
            {busy ? "Saving…" : kind === "task" ? "Add task" : "Save note"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Pre-populate helpers — given a reply, suggest a title.
export function deriveTitleFromReply(reply: string, max = 80): string {
  const sentences = reply.split(/(?<=[.!?])\s+/);
  const first = sentences[0]?.trim() ?? reply.trim();
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}
