import { useState } from "react";
import { Plus, MoreVertical, Trash2, Tag as TagIcon, Pencil } from "lucide-react";
import { toast } from "sonner";
import type { ChatSession } from "../types";
import type { UseChatSessionsResult } from "../hooks/useChatSessions";

interface Props {
  sessions: ChatSession[];
  loading: boolean;
  /** id of the session currently open in the chat panel — highlight it */
  activeId: string | null;
  onOpen: (id: string | null) => void;
  hooks: UseChatSessionsResult;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min + "m";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h";
  const d = Math.floor(hr / 24);
  if (d < 30) return d + "d";
  return Math.floor(d / 30) + "mo";
}

export function ChatSessionsList({ sessions, loading, activeId, onOpen, hooks }: Props) {
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <>
      <div className="px-3 py-2 border-b border-border">
        <button
          onClick={() => onOpen(null)}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded border border-border bg-bg-elevated hover:border-accent-primary px-3 py-1.5 text-xs font-display uppercase tracking-wider text-text-primary transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> New session
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-2 space-y-1">
        {loading && sessions.length === 0 && (
          <div className="text-xs text-text-muted px-3 py-6 text-center">Loading…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="text-xs text-text-muted px-3 py-6 text-center leading-relaxed">
            No sessions yet.<br />Start a conversation in the chat panel.
          </div>
        )}
        {sessions.map((s) => {
          const active = s.id === activeId;
          const isRenaming = renaming === s.id;
          return (
            <div
              key={s.id}
              onClick={() => !isRenaming && onOpen(s.id)}
              className={[
                "group relative px-3 py-2 rounded-md cursor-pointer transition-colors",
                "border-l-2",
                active
                  ? "bg-bg-elevated border-l-accent-primary"
                  : "border-l-transparent hover:bg-bg-elevated/60",
              ].join(" ")}
            >
              {isRenaming ? (
                <input
                  autoFocus
                  defaultValue={s.title}
                  onBlur={async (e) => {
                    const v = e.currentTarget.value.trim();
                    setRenaming(null);
                    if (v && v !== s.title) {
                      try { await hooks.rename(s.id, v); }
                      catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                    if (e.key === "Escape") { setRenaming(null); }
                  }}
                  className="w-full bg-bg-surface border border-accent-primary rounded px-2 py-1 text-sm text-text-primary focus:outline-none"
                />
              ) : (
                <div className="text-sm text-text-primary truncate pr-6">{s.title}</div>
              )}
              {!isRenaming && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-text-muted">{relativeTime(s.last_message_at || s.updated_at)}</span>
                  {s.tags.slice(0, 2).map((t) => (
                    <span key={t} className="text-[10px] px-1 rounded bg-bg-surface text-text-muted">{t}</span>
                  ))}
                  {s.tags.length > 2 && <span className="text-[10px] text-text-muted">+{s.tags.length - 2}</span>}
                </div>
              )}
              {!isRenaming && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(menuOpen === s.id ? null : s.id);
                  }}
                  className="absolute top-1.5 right-1.5 p-1 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Session menu"
                >
                  <MoreVertical className="w-3.5 h-3.5" />
                </button>
              )}
              {menuOpen === s.id && (
                <SessionMenu
                  session={s}
                  onClose={() => setMenuOpen(null)}
                  onRename={() => { setMenuOpen(null); setRenaming(s.id); }}
                  onSetTags={async (tags) => {
                    setMenuOpen(null);
                    try { await hooks.setTags(s.id, tags); }
                    catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
                  }}
                  onArchive={async () => {
                    setMenuOpen(null);
                    if (!confirm("Archive this session?")) return;
                    try {
                      await hooks.archive(s.id);
                      if (activeId === s.id) onOpen(null);
                    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
                  }}
                  onDelete={async () => {
                    setMenuOpen(null);
                    if (!confirm("Delete this session and all its messages? Cannot be undone.")) return;
                    try {
                      await hooks.remove(s.id);
                      if (activeId === s.id) onOpen(null);
                    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function SessionMenu({
  session, onClose, onRename, onSetTags, onArchive, onDelete,
}: {
  session: ChatSession;
  onClose: () => void;
  onRename: () => void;
  onSetTags: (tags: string[]) => Promise<void> | void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [tagInput, setTagInput] = useState(false);
  return (
    <>
      {/* Click-outside backdrop. */}
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute z-40 top-7 right-1 bg-bg-surface border border-border rounded shadow-lg py-1 min-w-[140px] text-xs"
      >
        <button onClick={onRename} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-elevated text-text-primary">
          <Pencil className="w-3 h-3" /> Rename
        </button>
        <button
          onClick={() => setTagInput(true)}
          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-elevated text-text-primary"
        >
          <TagIcon className="w-3 h-3" /> Edit tags
        </button>
        {tagInput && (
          <div className="px-3 py-1.5 border-t border-border" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              defaultValue={session.tags.join(", ")}
              placeholder="comma-separated"
              onBlur={(e) => {
                const tags = e.currentTarget.value.split(",").map((t) => t.trim()).filter(Boolean);
                void onSetTags(tags);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              }}
              className="w-full bg-bg-elevated border border-border rounded px-2 py-1 text-text-primary focus:outline-none"
            />
          </div>
        )}
        <div className="border-t border-border mt-1 pt-1">
          <button onClick={onArchive} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-elevated text-text-muted">
            Archive
          </button>
          <button onClick={onDelete} className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-rose-950/30 text-rose-300">
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        </div>
      </div>
    </>
  );
}
