import { useCallback, useEffect, useState } from "react";
import { listArticles } from "../api";
import type { Article, ArticleWindow } from "../types";

export function useArticles(window: ArticleWindow) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setArticles(await listArticles(window, 50));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [window]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { articles, loading, error, refresh };
}
