import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ArticleCard } from "./ArticleCard";
import type { Article, ArticleWindow } from "../types";

interface Props {
  articles: Article[];
  loading: boolean;
  window: ArticleWindow;
  onWindowChange: (w: ArticleWindow) => void;
  pinnedIds: Set<string>;
  onTogglePin: (id: string) => void;
}

export function ResearchFeed({ articles, loading, window, onWindowChange, pinnedIds, onTogglePin }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return articles;
    const q = query.toLowerCase();
    return articles.filter((a) => {
      const t = (a.title || "").toLowerCase();
      const s = (a.summary || "").toLowerCase();
      return t.includes(q) || s.includes(q);
    });
  }, [articles, query]);

  return (
    <>
      <div className="px-4 pt-4 pb-3 border-b border-border space-y-3">
        <div className="font-display text-xs uppercase tracking-widest text-text-muted">
          Research
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Search articles…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-bg-elevated border border-border rounded text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
          />
        </div>
        <select
          value={window}
          onChange={(e) => onWindowChange(e.target.value as ArticleWindow)}
          className="w-full px-2.5 py-1.5 text-xs bg-bg-elevated border border-border rounded text-text-primary focus:border-accent-primary focus:outline-none"
        >
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-2">
        {loading && articles.length === 0 && (
          <div className="text-xs text-text-muted px-3 py-6 text-center">Loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="text-xs text-text-muted px-3 py-6 text-center">
            {query ? "No matches." : "No articles in this window."}
          </div>
        )}
        {filtered.map((a) => (
          <ArticleCard
            key={a.id}
            article={a}
            pinned={pinnedIds.has(a.id)}
            onTogglePin={() => onTogglePin(a.id)}
          />
        ))}
      </div>
    </>
  );
}
