import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Search, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { listProjects, promoteIdea } from "../api";
import type { Idea, Project } from "../types";

interface Props {
  idea: Idea;
  onClose: () => void;
  onPromoted: (updated: Idea) => void;
}

type Step = "pick" | "new";

export function PromoteModal({ idea, onClose, onPromoted }: Props) {
  const [step, setStep] = useState<Step>("pick");
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // New-project state
  const [name, setName] = useState(idea.title);
  const [goal, setGoal] = useState("");
  const [priority, setPriority] = useState<"high" | "medium" | "low">("medium");
  // Inline error for when the chief-of-staff project list call fails.
  // The most common cause is a missing CHIEF_OF_STAFF_MCP_KEY secret on
  // the research-agent worker — surface the hint directly so the user
  // doesn't have to dig through transient toasts.
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ps = await listProjects();
        if (!cancelled) setProjects(ps);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setListError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!filter.trim()) return projects;
    const q = filter.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, filter]);

  const submitExisting = async () => {
    const proj = projects.find((p) => p.projectId === selected);
    if (!proj) { toast.error("Pick a project"); return; }
    setSaving(true);
    try {
      const { idea: updated } = await promoteIdea(idea.id, {
        mode: "existing",
        project_id: proj.projectId,
        project_name: proj.name,
      });
      toast.success(`Added to ${proj.name}`);
      onPromoted(updated);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const submitNew = async () => {
    if (!name.trim()) { toast.error("Project name required"); return; }
    setSaving(true);
    try {
      const { idea: updated } = await promoteIdea(idea.id, {
        mode: "new",
        project_name: name.trim(),
        goal: goal.trim(),
        priority,
      });
      toast.success(`Created project '${name.trim()}'`);
      onPromoted(updated);
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
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-bg-surface border border-border rounded-lg shadow-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <Dialog.Title className="font-display tracking-wide text-base">
              Promote idea to a project
            </Dialog.Title>
            <Dialog.Close className="text-text-muted hover:text-text-primary">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <p className="text-sm text-text-muted line-clamp-2">"{idea.title}"</p>

          {step === "pick" && (
            <>
              <div className="space-y-2">
                <div className="font-display text-[10px] uppercase tracking-widest text-text-muted">
                  Add to existing project
                </div>
                {listError ? (
                  <div className="rounded border border-rose-600/40 bg-rose-950/20 p-3 text-xs text-rose-200 space-y-1.5">
                    <div className="font-medium">Couldn't reach chief-of-staff:</div>
                    <div className="font-mono text-[11px] break-all">{listError}</div>
                    {listError.includes("CHIEF_OF_STAFF_MCP_KEY") || listError.includes("401") || listError.includes("Unauthorized") ? (
                      <div className="text-text-muted pt-1">
                        Set the secret on this worker so it can call chief-of-staff:<br />
                        <code className="text-[10px]">wrangler secret put CHIEF_OF_STAFF_MCP_KEY --name research-agent</code><br />
                        (value should match chief-of-staff's <code>MCP_HTTP_KEY</code>)
                      </div>
                    ) : null}
                    <div className="pt-1 text-text-muted">
                      You can still <button onClick={() => setStep("new")} className="underline hover:text-text-primary">create a new project</button> below.
                    </div>
                  </div>
                ) : (
                <div className="rounded border border-border bg-bg-elevated">
                  <div className="relative border-b border-border">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter projects…"
                      className="w-full pl-9 pr-3 py-2 text-sm bg-transparent text-text-primary placeholder:text-text-muted focus:outline-none"
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto scrollbar-thin">
                    {loading && <div className="px-3 py-2 text-xs text-text-muted">Loading…</div>}
                    {!loading && filtered.length === 0 && (
                      <div className="px-3 py-2 text-xs text-text-muted">No projects found.</div>
                    )}
                    {filtered.map((p) => (
                      <label
                        key={p.projectId}
                        className={[
                          "flex items-center gap-2 px-3 py-2 cursor-pointer text-sm",
                          selected === p.projectId ? "bg-accent-primary/10" : "hover:bg-bg-surface",
                        ].join(" ")}
                      >
                        <input
                          type="radio"
                          name="project"
                          value={p.projectId}
                          checked={selected === p.projectId}
                          onChange={() => setSelected(p.projectId)}
                          className="accent-accent-primary"
                        />
                        <span className="flex-1 truncate">{p.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                )}
              </div>
              <div className="text-center text-xs text-text-muted">— or —</div>
              <button
                onClick={() => setStep("new")}
                className="w-full text-center px-3 py-2 text-sm rounded border border-border text-text-muted hover:text-text-primary hover:border-accent-primary transition-colors"
              >
                + Create new project from this idea
              </button>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary">
                  Cancel
                </button>
                <button
                  onClick={submitExisting}
                  disabled={saving || !selected || !!listError}
                  className="rounded bg-accent-primary text-white px-3 py-1.5 text-sm disabled:opacity-40 inline-flex items-center gap-1 hover:bg-indigo-500 transition-colors"
                >
                  {saving ? "Promoting…" : <>Add as task <ArrowRight className="w-3.5 h-3.5" /></>}
                </button>
              </div>
            </>
          )}

          {step === "new" && (
            <>
              <div className="space-y-3">
                <div className="font-display text-[10px] uppercase tracking-widest text-text-muted">
                  New project details
                </div>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-widest text-text-muted">Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1 w-full bg-bg-elevated border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-widest text-text-muted">Goal</span>
                  <input
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="What does success look like?"
                    className="mt-1 w-full bg-bg-elevated border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
                  />
                </label>
                <div>
                  <span className="text-[10px] uppercase tracking-widest text-text-muted">Priority</span>
                  <div className="mt-1 inline-flex border border-border rounded overflow-hidden">
                    {(["high", "medium", "low"] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => setPriority(p)}
                        className={[
                          "px-3 py-1.5 text-xs font-display uppercase tracking-wider",
                          priority === p
                            ? "bg-accent-primary text-white"
                            : "text-text-muted hover:text-text-primary",
                        ].join(" ")}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-between gap-2 pt-2">
                <button onClick={() => setStep("pick")} className="text-sm text-text-muted hover:text-text-primary">
                  ← Back
                </button>
                <button
                  onClick={submitNew}
                  disabled={saving || !name.trim()}
                  className="rounded bg-accent-primary text-white px-3 py-1.5 text-sm disabled:opacity-40 inline-flex items-center gap-1 hover:bg-indigo-500 transition-colors"
                >
                  {saving ? "Promoting…" : <>Create &amp; add task <ArrowRight className="w-3.5 h-3.5" /></>}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
