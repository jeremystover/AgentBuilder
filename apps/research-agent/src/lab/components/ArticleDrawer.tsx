import { ExternalLink, X } from "lucide-react";
import { NoteSection } from "./NoteSection";
import type { Article } from "../types";

interface Props {
  article: Article;
  onClose: () => void;
}

/**
 * Lightweight read-only preview of an ingested article + its attached
 * notes. Article cards in the Research Feed open this drawer (instead
 * of just deep-linking out) so notes can hang off the article.
 *
 * Full-text fetching is deferred to the existing get_article tool /
 * direct URL — V1 just shows the summary that's already in the feed
 * payload.
 */
export function ArticleDrawer({ article, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        className="absolute inset-0 bg-bg-primary/60 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close drawer"
      />
      <div className="relative w-full max-w-md h-full bg-bg-surface border-l border-border overflow-y-auto scrollbar-thin">
        <div className="sticky top-0 z-10 bg-bg-surface border-b border-border px-5 py-3 flex items-center justify-between">
          <span className="font-display text-xs uppercase tracking-widest text-text-muted">Article</span>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-5 space-y-4">
          <h2 className="text-lg font-display tracking-wide text-text-primary leading-snug">
            {article.title || "(untitled)"}
          </h2>
          <div className="flex items-center gap-3 text-xs text-text-muted">
            {article.source_id && <span className="font-display uppercase tracking-wider">{article.source_id}</span>}
            <span>{new Date(article.ingested_at).toLocaleDateString()}</span>
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 ml-auto hover:text-text-primary"
            >
              Open original <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          {article.summary && (
            <div className="rounded border border-border bg-bg-elevated/50 p-3 text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
              {article.summary}
            </div>
          )}
          {article.topics.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {article.topics.slice(0, 12).map((t) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-elevated text-text-muted">{t}</span>
              ))}
            </div>
          )}
          <NoteSection target={{ kind: "article", id: article.id }} />
        </div>
      </div>
    </div>
  );
}
