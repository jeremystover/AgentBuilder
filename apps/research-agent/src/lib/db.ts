import type { D1Database } from "@cloudflare/workers-types";

// ── Row types ──────────────────────────────────────────────────

export interface ArticleRow {
  id:               string;
  source_id:        string | null;
  url:              string;
  canonical_url:    string | null;
  title:            string | null;
  author:           string | null;
  published_at:     string | null;
  ingested_at:      string;
  summary:          string | null;
  full_text:        string | null;
  html:             string | null;
  word_count:       number | null;
  reading_time_min: number | null;
  language:         string | null;
  topics:           string | null;
  entities:         string | null;
  r2_key:           string | null;
  vector_id:        string | null;
  status:           "pending" | "processing" | "ready" | "error";
  error_message:    string | null;
}

export interface UpsertReadyParams {
  id:               string;
  source_id:        string | null;
  url:              string;
  canonical_url:    string | null;
  title:            string | null;
  author:           string | null;
  published_at:     string | null;
  ingested_at:      string;
  summary:          string | null;
  full_text:        string | null;
  html:             string | null;
  word_count:       number | null;
  reading_time_min: number | null;
  topics:           string | null;
  r2_key:           string | null;
  vector_id:        string | null;
  status:           "ready" | "error";
}

export interface UpsertErrorParams {
  id:        string;
  url:       string;
  source_id: string | null;
  error:     string;
}

export interface FeedbackRow {
  id:         string;
  article_id: string;
  signal:     string;
  context:    string | null;
  note:       string | null;
  created_at: string;
}

// ── articleQueries ─────────────────────────────────────────────

export const articleQueries = {

  async findByUrl(db: D1Database, url: string): Promise<ArticleRow | null> {
    const result = await db
      .prepare("SELECT * FROM articles WHERE url = ? LIMIT 1")
      .bind(url)
      .first<ArticleRow>();
    return result ?? null;
  },

  async findById(db: D1Database, id: string): Promise<ArticleRow | null> {
    const result = await db
      .prepare("SELECT * FROM articles WHERE id = ? LIMIT 1")
      .bind(id)
      .first<ArticleRow>();
    return result ?? null;
  },

  async upsertReady(db: D1Database, p: UpsertReadyParams): Promise<void> {
    await db
      .prepare(`
        INSERT INTO articles (
          id, source_id, url, canonical_url, title, author,
          published_at, ingested_at, summary, full_text, html,
          word_count, reading_time_min, topics, r2_key, vector_id, status
        ) VALUES (
          ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17
        )
        ON CONFLICT(url) DO UPDATE SET
          canonical_url    = excluded.canonical_url,
          title            = excluded.title,
          author           = excluded.author,
          published_at     = excluded.published_at,
          ingested_at      = excluded.ingested_at,
          summary          = excluded.summary,
          full_text        = excluded.full_text,
          html             = excluded.html,
          word_count       = excluded.word_count,
          reading_time_min = excluded.reading_time_min,
          topics           = excluded.topics,
          r2_key           = excluded.r2_key,
          vector_id        = excluded.vector_id,
          status           = excluded.status,
          error_message    = NULL
      `)
      .bind(
        p.id, p.source_id, p.url, p.canonical_url, p.title, p.author,
        p.published_at, p.ingested_at, p.summary, p.full_text, p.html,
        p.word_count, p.reading_time_min, p.topics, p.r2_key, p.vector_id, p.status,
      )
      .run();
  },

  async upsertError(db: D1Database, p: UpsertErrorParams): Promise<void> {
    const now = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO articles (id, url, source_id, status, error_message, ingested_at)
        VALUES (?1, ?2, ?3, 'error', ?4, ?5)
        ON CONFLICT(url) DO UPDATE SET
          status        = 'error',
          error_message = excluded.error_message,
          ingested_at   = excluded.ingested_at
      `)
      .bind(p.id, p.url, p.source_id, p.error, now)
      .run();
  },

  async listRecent(
    db: D1Database,
    opts: { limit?: number; offset?: number; status?: string } = {},
  ): Promise<ArticleRow[]> {
    const limit  = opts.limit  ?? 20;
    const offset = opts.offset ?? 0;
    if (opts.status) {
      const r = await db
        .prepare("SELECT * FROM articles WHERE status = ?1 ORDER BY ingested_at DESC LIMIT ?2 OFFSET ?3")
        .bind(opts.status, limit, offset)
        .all<ArticleRow>();
      return r.results;
    }
    const r = await db
      .prepare("SELECT * FROM articles ORDER BY ingested_at DESC LIMIT ?1 OFFSET ?2")
      .bind(limit, offset)
      .all<ArticleRow>();
    return r.results;
  },

  async fullTextSearch(
    db: D1Database,
    query: string,
    limit = 20,
    offset = 0,
  ): Promise<ArticleRow[]> {
    const safe = query.replace(/['"*^]/g, " ").trim();
    const r = await db
      .prepare(`
        SELECT a.*
        FROM articles a
        JOIN articles_fts f ON a.rowid = f.rowid
        WHERE articles_fts MATCH ?1
        ORDER BY rank
        LIMIT ?2 OFFSET ?3
      `)
      .bind(safe, limit, offset)
      .all<ArticleRow>();
    return r.results;
  },

  async fetchIdsIn(db: D1Database, ids: string[]): Promise<ArticleRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const r = await db
      .prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<ArticleRow>();
    return r.results;
  },

  async updateVectorId(db: D1Database, articleId: string, vectorId: string): Promise<void> {
    await db
      .prepare("UPDATE articles SET vector_id = ?1 WHERE id = ?2")
      .bind(vectorId, articleId)
      .run();
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  },
};

// ── feedbackQueries ────────────────────────────────────────────

export const feedbackQueries = {

  async insert(
    db: D1Database,
    p: { article_id: string; signal: string; context?: string; note?: string },
  ): Promise<void> {
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO feedback (id, article_id, signal, context, note, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `)
      .bind(id, p.article_id, p.signal, p.context ?? null, p.note ?? null, now)
      .run();
  },

  async listForArticle(db: D1Database, articleId: string): Promise<FeedbackRow[]> {
    const r = await db
      .prepare("SELECT * FROM feedback WHERE article_id = ? ORDER BY created_at DESC")
      .bind(articleId)
      .all<FeedbackRow>();
    return r.results;
  },

  async signalCounts(db: D1Database): Promise<Array<{ signal: string; count: number }>> {
    const r = await db
      .prepare("SELECT signal, COUNT(*) as count FROM feedback GROUP BY signal ORDER BY count DESC")
      .all<{ signal: string; count: number }>();
    return r.results;
  },
};

// ── profileQueries ─────────────────────────────────────────────

export const profileQueries = {

  async get<T = unknown>(db: D1Database, key: string): Promise<T | null> {
    const row = await db
      .prepare("SELECT value FROM interest_profile WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    if (!row) return null;
    try { return JSON.parse(row.value) as T; }
    catch { return row.value as unknown as T; }
  },

  async set(db: D1Database, key: string, value: unknown): Promise<void> {
    const now = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO interest_profile (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET
          value      = excluded.value,
          updated_at = excluded.updated_at
      `)
      .bind(key, JSON.stringify(value), now)
      .run();
  },

  async getAll(db: D1Database): Promise<Record<string, unknown>> {
    const r = await db
      .prepare("SELECT key, value FROM interest_profile")
      .all<{ key: string; value: string }>();
    return Object.fromEntries(
      r.results.map((row) => {
        try { return [row.key, JSON.parse(row.value)]; }
        catch { return [row.key, row.value]; }
      }),
    );
  },

  async delete(db: D1Database, key: string): Promise<void> {
    await db.prepare("DELETE FROM interest_profile WHERE key = ?").bind(key).run();
  },
};
