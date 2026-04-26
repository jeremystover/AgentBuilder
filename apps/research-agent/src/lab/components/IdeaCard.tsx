import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { Idea, IdeaStatus } from "../types";

interface Props {
  idea: Idea;
  onAdvance?: (status: IdeaStatus) => void;
  onPromote: () => void;
  onOpen: () => void;
}

const STATUS_BORDER: Record<IdeaStatus, string> = {
  spark:     "border-l-accent-spark",
  developing:"border-l-accent-develop",
  ready:     "border-l-accent-ready",
  promoted:  "border-l-accent-promoted opacity-70",
};

const NEXT_STATUS: Partial<Record<IdeaStatus, IdeaStatus>> = {
  spark: "developing",
  developing: "ready",
};

const NEXT_LABEL: Partial<Record<IdeaStatus, string>> = {
  spark: "Develop",
  developing: "Ready",
};

export function IdeaCard({ idea, onAdvance, onPromote, onOpen }: Props) {
  const next = NEXT_STATUS[idea.status];
  const nextLabel = NEXT_LABEL[idea.status];
  return (
    <div
      onClick={onOpen}
      className={[
        "group rounded-md bg-bg-elevated border border-border border-l-2 px-3 py-2.5",
        "cursor-pointer hover:border-accent-primary/60 transition-colors",
        STATUS_BORDER[idea.status],
      ].join(" ")}
    >
      <div className="flex items-baseline gap-2 mb-1">
        <span className="font-display text-[10px] uppercase tracking-widest text-text-muted">
          {idea.status}
        </span>
      </div>
      <div className="text-sm text-text-primary leading-snug line-clamp-2 mb-2">
        {idea.title || "(untitled)"}
      </div>
      {idea.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {idea.tags.slice(0, 4).map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-text-muted">
              {t}
            </span>
          ))}
        </div>
      )}
      {idea.linked_article_ids.length > 0 && (
        <div className="text-[11px] text-text-muted mb-2">
          {idea.linked_article_ids.length} linked article{idea.linked_article_ids.length === 1 ? "" : "s"}
        </div>
      )}
      {/* Action row — always visible. Earlier version was opacity-0 with
          group-hover reveal, but that hid the affordance entirely on
          touch devices and made keyboard/screen-reader access painful.
          The actions sit at the bottom of the card with subdued text so
          they don't visually compete with the title. */}
      <div className="flex items-center gap-2 mt-2">
        {next && nextLabel && onAdvance && (
          <button
            onClick={(e) => { e.stopPropagation(); onAdvance(next); }}
            className="text-[11px] text-text-muted hover:text-text-primary inline-flex items-center gap-0.5"
          >
            <ChevronRight className="w-3 h-3" /> {nextLabel}
          </button>
        )}
        {idea.status !== "promoted" && (
          <button
            onClick={(e) => { e.stopPropagation(); onPromote(); }}
            className="ml-auto text-[11px] text-accent-promoted hover:text-violet-400 inline-flex items-center gap-0.5"
          >
            <ArrowUpRight className="w-3 h-3" /> Promote
          </button>
        )}
        {idea.status === "promoted" && idea.promoted_to && (
          <span className="ml-auto text-[10px] text-text-muted truncate max-w-[140px]" title={idea.promoted_to.project_name}>
            → {idea.promoted_to.project_name}
          </span>
        )}
      </div>
    </div>
  );
}
