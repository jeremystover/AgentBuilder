import { useEffect, useRef, useState } from "react";
import { ArrowUp, Lightbulb, Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { Article, ChatScope } from "../types";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  scope: ChatScope;
  onScopeChange: (s: ChatScope) => void;
  pinnedArticles: Article[];
  turns: Turn[];
  loading: boolean;
  onSend: (msg: string) => Promise<string>;
  onSaveAsIdea: (text: string) => void;
  onClear: () => void;
}

const SCOPE_OPTIONS: Array<{ id: ChatScope; label: string; hint: string }> = [
  { id: "selected",    label: "Selected",    hint: "Only pinned articles" },
  { id: "digest",      label: "Digest",      hint: "Articles in current window" },
  { id: "full_corpus", label: "Full Corpus", hint: "Search whole library" },
];

export function ChatPanel({
  scope, onScopeChange, pinnedArticles, turns, loading, onSend, onSaveAsIdea, onClear,
}: Props) {
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length, loading]);

  const submit = async () => {
    const msg = draft.trim();
    if (!msg) return;
    if (scope === "selected" && pinnedArticles.length === 0) {
      toast.error("Pin at least one article, or switch scope to Digest or Full Corpus.");
      return;
    }
    setDraft("");
    try {
      await onSend(msg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Scope toggle + pinned chips */}
      <div className="px-5 py-3 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden bg-bg-surface">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => onScopeChange(opt.id)}
                title={opt.hint}
                className={[
                  "px-3 py-1.5 text-xs font-display uppercase tracking-wider transition-colors",
                  scope === opt.id
                    ? "bg-accent-primary text-white"
                    : "text-text-muted hover:text-text-primary",
                ].join(" ")}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {turns.length > 0 && (
            <button
              onClick={onClear}
              className="ml-auto text-xs text-text-muted hover:text-text-primary"
            >
              Clear
            </button>
          )}
        </div>
        {(scope === "selected" || scope === "digest") && pinnedArticles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pinnedArticles.slice(0, 8).map((a) => (
              <span
                key={a.id}
                className="text-xs px-2 py-0.5 rounded-full bg-bg-elevated border border-border text-text-muted truncate max-w-[200px]"
                title={a.title || ""}
              >
                {a.title || "(untitled)"}
              </span>
            ))}
            {pinnedArticles.length > 8 && (
              <span className="text-xs text-text-muted">+{pinnedArticles.length - 8}</span>
            )}
          </div>
        )}
      </div>

      {/* Transcript */}
      <div ref={transcriptRef} className="flex-1 overflow-y-auto scrollbar-thin px-6 py-6 space-y-4">
        {turns.length === 0 && !loading && (
          <div className="h-full flex items-center justify-center">
            <div className="max-w-md text-center space-y-3">
              <Sparkles className="w-8 h-8 mx-auto text-accent-primary opacity-60" />
              <h2 className="font-display text-xl tracking-wide">What's on your mind?</h2>
              <p className="text-sm text-text-muted">
                Pin articles on the left, or switch to Full Corpus and ask a question.
                Save synthesis you like as an idea.
              </p>
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <Bubble
            key={i}
            role={t.role}
            content={t.content}
            onSaveAsIdea={t.role === "assistant" ? () => onSaveAsIdea(t.content) : undefined}
          />
        ))}
        {loading && (
          <div className="text-text-muted italic text-sm">Thinking…</div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border px-5 py-4">
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Ask, synthesize, brainstorm. ⌘↵ to send."
            className="flex-1 resize-none bg-bg-surface border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
          />
          <button
            onClick={() => void submit()}
            disabled={loading || !draft.trim()}
            className="rounded-md bg-accent-primary text-white px-3 py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-indigo-500 transition-colors"
            aria-label="Send"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  role, content, onSaveAsIdea,
}: { role: "user" | "assistant"; content: string; onSaveAsIdea?: () => void }) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent-primary text-white px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed">
          {content}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5 max-w-[90%]">
      <div className="rounded-2xl rounded-bl-sm bg-bg-elevated border border-border px-3.5 py-2.5 text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
        {content}
      </div>
      {onSaveAsIdea && (
        <button
          onClick={onSaveAsIdea}
          className="inline-flex items-center gap-1.5 text-xs text-accent-spark hover:text-amber-400 transition-colors"
        >
          <Lightbulb className="w-3 h-3" />
          Save as idea
        </button>
      )}
    </div>
  );
}
