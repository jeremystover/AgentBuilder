import { useState } from "react";
import { Plus, LayoutGrid, Network } from "lucide-react";
import { IdeaBoard } from "./IdeaBoard";
import { IdeaMindMap } from "./IdeaMindMap";
import type { Idea, IdeaStatus } from "../types";

interface Props {
  ideas: Idea[];
  loading: boolean;
  onNewIdea: () => void;
  onAdvance: (id: string, status: IdeaStatus) => Promise<void>;
  onOpen: (idea: Idea) => void;
  onPromote: (idea: Idea) => void;
}

type View = "board" | "map";

export function IdeasPanel({ ideas, loading, onNewIdea, onAdvance, onOpen, onPromote }: Props) {
  const [view, setView] = useState<View>("board");

  return (
    <>
      <div className="px-4 pt-4 pb-3 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-display text-xs uppercase tracking-widest text-text-muted">
            Ideas {ideas.length > 0 && <span className="ml-1 text-text-muted/60">({ideas.length})</span>}
          </div>
          <div className="flex items-center gap-2">
            <ViewToggle view={view} onChange={setView} />
            <button
              onClick={onNewIdea}
              className="text-xs text-text-muted hover:text-text-primary inline-flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> New idea
            </button>
          </div>
        </div>
      </div>

      {loading && ideas.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-text-muted">
          Loading ideas…
        </div>
      ) : view === "board" ? (
        <IdeaBoard ideas={ideas} onAdvance={onAdvance} onOpen={onOpen} onPromote={onPromote} />
      ) : (
        <IdeaMindMap ideas={ideas} onOpen={onOpen} />
      )}
    </>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="inline-flex rounded border border-border overflow-hidden">
      <button
        onClick={() => onChange("board")}
        className={[
          "px-2 py-1",
          view === "board" ? "bg-accent-primary text-white" : "text-text-muted hover:text-text-primary",
        ].join(" ")}
        aria-label="Board view"
        title="Board"
      >
        <LayoutGrid className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => onChange("map")}
        className={[
          "px-2 py-1",
          view === "map" ? "bg-accent-primary text-white" : "text-text-muted hover:text-text-primary",
        ].join(" ")}
        aria-label="Map view"
        title="Map"
      >
        <Network className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
