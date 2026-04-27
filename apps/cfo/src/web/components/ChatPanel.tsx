import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send, Square, Trash2, Wallet } from "lucide-react";
import type { RenderTurn } from "../hooks/useChat";

interface Props {
  turns: RenderTurn[];
  loading: boolean;
  onSend(message: string): void;
  onCancel(): void;
  onClear(): void;
}

export function ChatPanel({ turns, loading, onSend, onCancel, onClear }: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const msg = draft.trim();
    if (!msg || loading) return;
    setDraft("");
    onSend(msg);
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 scrollbar-thin">
        {turns.length === 0 ? (
          <Empty />
        ) : (
          <div className="max-w-3xl mx-auto flex flex-col gap-5">
            {turns.map((t) => (
              <Turn key={t.id} turn={t} />
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={submit}
        className="border-t border-border bg-bg-surface px-6 py-4"
      >
        <div className="max-w-3xl mx-auto flex items-end gap-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(e as unknown as FormEvent);
              }
            }}
            placeholder="Ask the CFO…"
            rows={2}
            className="flex-1 resize-none rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent-primary"
          />
          {loading ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-danger px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              <Square className="w-4 h-4" /> Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              <Send className="w-4 h-4" /> Send
            </button>
          )}
          {turns.length > 0 && !loading && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:bg-bg-elevated"
              title="Clear conversation"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function Turn({ turn }: { turn: RenderTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-accent-primary px-4 py-2.5 text-sm text-white whitespace-pre-wrap">
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl bg-bg-surface border border-border px-4 py-3 text-sm text-text-primary whitespace-pre-wrap">
        {turn.content || (turn.streaming ? <span className="text-text-subtle italic">Thinking…</span> : null)}
        {turn.pills.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {turn.pills.map((p) => (
              <span
                key={p.id}
                className={
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs " +
                  (p.status === "running"
                    ? "bg-accent-primary/10 text-accent-primary"
                    : p.status === "error"
                      ? "bg-accent-danger/10 text-accent-danger"
                      : "bg-accent-success/10 text-accent-success")
                }
                title={p.summary ?? p.name}
              >
                <span className="font-mono">{p.name}</span>
                {p.summary && (
                  <>
                    <span className="opacity-50">·</span>
                    <span className="opacity-90">{p.summary}</span>
                  </>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-md text-center">
        <Wallet className="w-10 h-10 mx-auto text-accent-primary mb-3" />
        <h2 className="text-lg font-semibold text-text-primary">CFO</h2>
        <p className="text-sm text-text-muted mt-2">
          Ask about your books — P&amp;L, budgets, transactions, the review queue.
          Try <em>"how did we do last month?"</em> or <em>"what's left to classify?"</em>
        </p>
      </div>
    </div>
  );
}
