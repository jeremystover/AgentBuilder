import { Star, ExternalLink } from "lucide-react";
import type { Article } from "../types";

interface Props {
  article: Article;
  pinned: boolean;
  onTogglePin: () => void;
  /** Optional click on the card body (everything except the pin star + external-link icon). */
  onOpen?: () => void;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = Math.floor(ms / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "1 day ago";
  if (d < 30) return `${d} days ago`;
  const m = Math.floor(d / 30);
  return m === 1 ? "1 month ago" : `${m} months ago`;
}

export function ArticleCard({ article, pinned, onTogglePin, onOpen }: Props) {
  return (
    <div
      onClick={onOpen}
      className={[
        "group relative px-3 py-2.5 rounded-md transition-colors",
        onOpen ? "cursor-pointer" : "cursor-default",
        "hover:bg-bg-elevated",
        pinned ? "border-l-2 border-accent-spark pl-[10px]" : "border-l-2 border-transparent",
      ].join(" ")}
    >
      <div className="flex items-start gap-2">
        <button
          className={[
            "mt-0.5 shrink-0 rounded transition-transform active:scale-125",
            pinned ? "text-accent-spark" : "text-text-muted hover:text-accent-spark",
          ].join(" ")}
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          title={pinned ? "Unpin" : "Pin to selection"}
          aria-label={pinned ? "Unpin article" : "Pin article"}
        >
          <Star className="w-4 h-4" fill={pinned ? "currentColor" : "none"} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm leading-snug line-clamp-2 text-text-primary">
            {article.title || "(untitled)"}
          </div>
          {article.summary && (
            <div className="text-xs text-text-muted mt-1 line-clamp-3 leading-relaxed">
              {article.summary}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            {article.source_id && (
              <span className="font-display text-[10px] uppercase tracking-wider text-text-muted">
                {article.source_id}
              </span>
            )}
            <span className="text-[10px] text-text-muted ml-auto">{relativeTime(article.ingested_at)}</span>
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
              title="Open original"
              aria-label="Open original article"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
