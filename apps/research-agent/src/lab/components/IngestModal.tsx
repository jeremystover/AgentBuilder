import { useState, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Link2, Upload } from "lucide-react";
import { toast } from "sonner";
import { ingestUrl, ingestFile } from "../api";

interface Props {
  onClose: () => void;
  /** Called after successful ingest so the feed can refresh. */
  onIngested: () => void;
}

type Mode = "url" | "file";

export function IngestModal({ onClose, onIngested }: Props) {
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "url") {
        if (!url.trim()) { toast.error("URL is required"); return; }
        await ingestUrl(url.trim(), note.trim() || undefined);
        toast.success("Ingestion queued — article will appear in the feed shortly");
      } else {
        if (!file) { toast.error("Pick a file to upload"); return; }
        await ingestFile(file, note.trim() || undefined);
        toast.success(`Uploaded ${file.name}`);
      }
      onIngested();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-bg-primary/60 backdrop-blur-sm z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-bg-surface border border-border rounded-lg shadow-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-display tracking-wide text-lg">Add to research</Dialog.Title>
            <Dialog.Close className="text-text-muted hover:text-text-primary">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <div className="inline-flex rounded border border-border overflow-hidden">
            <ModeBtn mode="url" current={mode} onClick={() => setMode("url")} icon={<Link2 className="w-3.5 h-3.5" />} label="URL" />
            <ModeBtn mode="file" current={mode} onClick={() => setMode("file")} icon={<Upload className="w-3.5 h-3.5" />} label="File" />
          </div>

          {mode === "url" && (
            <input
              autoFocus
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
            />
          )}
          {mode === "file" && (
            <div>
              <input
                ref={fileRef}
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="hidden"
                accept=".pdf,.txt,.md,.docx,.png,.jpg,.jpeg,.webp"
              />
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full px-4 py-6 border border-dashed border-border rounded text-sm text-text-muted hover:border-accent-primary hover:text-text-primary transition-colors"
              >
                {file ? <>{file.name} <span className="text-xs opacity-60">({Math.round(file.size / 1024)} KB)</span></> : "Click to pick a PDF, image, or document"}
              </button>
            </div>
          )}

          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)…"
            className="w-full bg-bg-elevated border border-border rounded px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none resize-none"
          />

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary">Cancel</button>
            <button
              onClick={submit}
              disabled={busy || (mode === "url" ? !url.trim() : !file)}
              className="rounded bg-accent-primary text-white px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-indigo-500 transition-colors"
            >
              {busy ? "Working…" : "Add"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ModeBtn({ mode, current, onClick, icon, label }: { mode: Mode; current: Mode; onClick: () => void; icon: React.ReactNode; label: string }) {
  const active = mode === current;
  return (
    <button
      onClick={onClick}
      className={[
        "flex items-center gap-1.5 px-3 py-1.5 text-xs font-display uppercase tracking-wider transition-colors",
        active ? "bg-accent-primary text-white" : "text-text-muted hover:text-text-primary",
      ].join(" ")}
    >
      {icon} {label}
    </button>
  );
}
