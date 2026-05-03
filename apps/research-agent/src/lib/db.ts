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

// ── Row types (categories, attachments, cleanup) ──────────────

export interface CategoryRow {
  id:          string;
  name:        string;
  slug:        string;
  description: string | null;
  color:       string | null;
  parent_id:   string | null;
  created_at:  string;
  updated_at:  string;
}

export interface AttachmentRow {
  id:             string;
  article_id:     string | null;
  filename:       string;
  mime_type:      string;
  file_size:      number;
  r2_key:         string;
  ocr_text:       string | null;
  ocr_confidence: number | null;
  is_text_image:  number;
  vector_id:      string | null;
  created_at:     string;
}

export interface CleanupLogRow {
  id:          string;
  action:      string;
  target_type: string;
  target_id:   string;
  reason:      string | null;
  details:     string | null;
  status:      string;
  batch_id:    string | null;
  proposed_at: string;
  resolved_at: string | null;
}

// ── categoryQueries ───────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const categoryQueries = {

  async create(
    db: D1Database,
    p: { name: string; description?: string; color?: string; parent_id?: string },
  ): Promise<CategoryRow> {
    const id   = crypto.randomUUID();
    const now  = new Date().toISOString();
    let slug   = slugify(p.name);

    const existing = await db.prepare("SELECT 1 FROM categories WHERE slug = ?").bind(slug).first();
    if (existing) slug = `${slug}-${id.slice(0, 6)}`;

    await db
      .prepare(`
        INSERT INTO categories (id, name, slug, description, color, parent_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `)
      .bind(id, p.name, slug, p.description ?? null, p.color ?? null, p.parent_id ?? null, now, now)
      .run();

    return { id, name: p.name, slug, description: p.description ?? null, color: p.color ?? null, parent_id: p.parent_id ?? null, created_at: now, updated_at: now };
  },

  async findById(db: D1Database, id: string): Promise<CategoryRow | null> {
    return (await db.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first<CategoryRow>()) ?? null;
  },

  async findBySlug(db: D1Database, slug: string): Promise<CategoryRow | null> {
    return (await db.prepare("SELECT * FROM categories WHERE slug = ?").bind(slug).first<CategoryRow>()) ?? null;
  },

  async list(db: D1Database, parentId?: string): Promise<CategoryRow[]> {
    if (parentId !== undefined) {
      const r = await db
        .prepare("SELECT * FROM categories WHERE parent_id = ? ORDER BY name")
        .bind(parentId)
        .all<CategoryRow>();
      return r.results;
    }
    const r = await db.prepare("SELECT * FROM categories ORDER BY name").all<CategoryRow>();
    return r.results;
  },

  async listWithCounts(db: D1Database): Promise<Array<CategoryRow & { article_count: number }>> {
    const r = await db
      .prepare(`
        SELECT c.*, COUNT(ac.article_id) AS article_count
        FROM categories c
        LEFT JOIN article_categories ac ON c.id = ac.category_id
        GROUP BY c.id
        ORDER BY c.name
      `)
      .all<CategoryRow & { article_count: number }>();
    return r.results;
  },

  async update(
    db: D1Database,
    id: string,
    patch: { name?: string; description?: string; color?: string; parent_id?: string | null },
  ): Promise<CategoryRow | null> {
    const existing = await db.prepare("SELECT * FROM categories WHERE id = ?").bind(id).first<CategoryRow>();
    if (!existing) return null;

    const now  = new Date().toISOString();
    const name = patch.name ?? existing.name;
    const slug = patch.name ? slugify(patch.name) : existing.slug;

    await db
      .prepare(`
        UPDATE categories SET name = ?1, slug = ?2, description = ?3, color = ?4, parent_id = ?5, updated_at = ?6
        WHERE id = ?7
      `)
      .bind(
        name, slug,
        patch.description !== undefined ? patch.description : existing.description,
        patch.color !== undefined ? patch.color : existing.color,
        patch.parent_id !== undefined ? patch.parent_id : existing.parent_id,
        now, id,
      )
      .run();

    return { ...existing, name, slug, description: patch.description ?? existing.description, color: patch.color ?? existing.color, parent_id: patch.parent_id !== undefined ? patch.parent_id : existing.parent_id, updated_at: now };
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
  },
};

// ── articleCategoryQueries ────────────────────────────────────

export const articleCategoryQueries = {

  async assign(
    db: D1Database,
    articleId: string,
    categoryId: string,
    assignedBy = "manual",
  ): Promise<void> {
    const now = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO article_categories (article_id, category_id, assigned_at, assigned_by)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(article_id, category_id) DO NOTHING
      `)
      .bind(articleId, categoryId, now, assignedBy)
      .run();
  },

  async bulkAssign(
    db: D1Database,
    articleId: string,
    categoryIds: string[],
    assignedBy = "manual",
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const categoryId of categoryIds) {
      await db
        .prepare(`
          INSERT INTO article_categories (article_id, category_id, assigned_at, assigned_by)
          VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(article_id, category_id) DO NOTHING
        `)
        .bind(articleId, categoryId, now, assignedBy)
        .run();
    }
  },

  async remove(db: D1Database, articleId: string, categoryId: string): Promise<void> {
    await db
      .prepare("DELETE FROM article_categories WHERE article_id = ?1 AND category_id = ?2")
      .bind(articleId, categoryId)
      .run();
  },

  async listForArticle(db: D1Database, articleId: string): Promise<CategoryRow[]> {
    const r = await db
      .prepare(`
        SELECT c.* FROM categories c
        JOIN article_categories ac ON c.id = ac.category_id
        WHERE ac.article_id = ?
        ORDER BY c.name
      `)
      .bind(articleId)
      .all<CategoryRow>();
    return r.results;
  },

  async listArticleIds(db: D1Database, categoryId: string, limit = 50, offset = 0): Promise<string[]> {
    const r = await db
      .prepare("SELECT article_id FROM article_categories WHERE category_id = ?1 LIMIT ?2 OFFSET ?3")
      .bind(categoryId, limit, offset)
      .all<{ article_id: string }>();
    return r.results.map((row) => row.article_id);
  },

  async countForArticle(db: D1Database, articleId: string): Promise<number> {
    const row = await db
      .prepare("SELECT COUNT(*) AS cnt FROM article_categories WHERE article_id = ?")
      .bind(articleId)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  },

  async deleteAllForArticle(db: D1Database, articleId: string): Promise<void> {
    await db.prepare("DELETE FROM article_categories WHERE article_id = ?").bind(articleId).run();
  },
};

// ── attachmentQueries ─────────────────────────────────────────

export const attachmentQueries = {

  async create(
    db: D1Database,
    p: {
      id: string;
      article_id?: string;
      filename: string;
      mime_type: string;
      file_size: number;
      r2_key: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO attachments (id, article_id, filename, mime_type, file_size, r2_key, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `)
      .bind(p.id, p.article_id ?? null, p.filename, p.mime_type, p.file_size, p.r2_key, now)
      .run();
  },

  async findById(db: D1Database, id: string): Promise<AttachmentRow | null> {
    return (await db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<AttachmentRow>()) ?? null;
  },

  async listForArticle(db: D1Database, articleId: string): Promise<AttachmentRow[]> {
    const r = await db
      .prepare("SELECT * FROM attachments WHERE article_id = ? ORDER BY created_at DESC")
      .bind(articleId)
      .all<AttachmentRow>();
    return r.results;
  },

  async updateOcr(
    db: D1Database,
    id: string,
    ocrText: string,
    isTextImage: boolean,
    vectorId?: string,
  ): Promise<void> {
    await db
      .prepare("UPDATE attachments SET ocr_text = ?1, is_text_image = ?2, vector_id = ?3 WHERE id = ?4")
      .bind(ocrText, isTextImage ? 1 : 0, vectorId ?? null, id)
      .run();
  },

  async linkToArticle(db: D1Database, attachmentId: string, articleId: string): Promise<void> {
    await db
      .prepare("UPDATE attachments SET article_id = ? WHERE id = ?")
      .bind(articleId, attachmentId)
      .run();
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
  },

  async listAll(db: D1Database, opts: { limit?: number; offset?: number } = {}): Promise<AttachmentRow[]> {
    const limit  = opts.limit  ?? 50;
    const offset = opts.offset ?? 0;
    const r = await db
      .prepare("SELECT * FROM attachments ORDER BY created_at DESC LIMIT ?1 OFFSET ?2")
      .bind(limit, offset)
      .all<AttachmentRow>();
    return r.results;
  },

  async listAllR2Keys(db: D1Database): Promise<string[]> {
    const r = await db.prepare("SELECT r2_key FROM attachments").all<{ r2_key: string }>();
    return r.results.map((row) => row.r2_key);
  },
};

// ── Row types (watches) ───────────────────────────────────────

export type WatchMatchType = "contains" | "not_contains" | "regex" | "hash";
export type WatchNotifyMode = "once" | "every";

export interface WatchRow {
  id:                 string;
  name:               string;
  url:                string;
  interval_minutes:   number;
  match_type:         WatchMatchType;
  match_value:        string | null;
  notify_email:       string;
  notify_mode:        WatchNotifyMode;
  enabled:            number;
  last_checked_at:    string | null;
  last_hash:          string | null;
  last_matched_at:    string | null;
  last_notified_at:   string | null;
  last_error:         string | null;
  consecutive_errors: number;
  created_at:         string;
  updated_at:         string;
}

export interface WatchHitRow {
  id:         string;
  watch_id:   string;
  matched_at: string;
  snippet:    string | null;
  page_hash:  string | null;
  notified:   number;
}

// ── watchQueries ──────────────────────────────────────────────

export const watchQueries = {

  async create(
    db: D1Database,
    p: {
      id: string;
      name: string;
      url: string;
      interval_minutes: number;
      match_type: WatchMatchType;
      match_value: string | null;
      notify_email: string;
      notify_mode: WatchNotifyMode;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO watches (
          id, name, url, interval_minutes, match_type, match_value,
          notify_email, notify_mode, enabled, consecutive_errors,
          created_at, updated_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,0,?9,?9)
      `)
      .bind(
        p.id, p.name, p.url, p.interval_minutes, p.match_type,
        p.match_value, p.notify_email, p.notify_mode, now,
      )
      .run();
  },

  async findById(db: D1Database, id: string): Promise<WatchRow | null> {
    return (await db.prepare("SELECT * FROM watches WHERE id = ?").bind(id).first<WatchRow>()) ?? null;
  },

  async list(db: D1Database, opts: { enabled?: boolean } = {}): Promise<WatchRow[]> {
    if (opts.enabled !== undefined) {
      const r = await db
        .prepare("SELECT * FROM watches WHERE enabled = ?1 ORDER BY created_at DESC")
        .bind(opts.enabled ? 1 : 0)
        .all<WatchRow>();
      return r.results;
    }
    const r = await db.prepare("SELECT * FROM watches ORDER BY created_at DESC").all<WatchRow>();
    return r.results;
  },

  /** List watches whose next check is due: never-checked OR last_checked_at <= now - interval. */
  async listDue(db: D1Database, nowIso: string): Promise<WatchRow[]> {
    const r = await db
      .prepare(`
        SELECT * FROM watches
        WHERE enabled = 1
          AND (
            last_checked_at IS NULL
            OR datetime(last_checked_at, '+' || interval_minutes || ' minutes') <= datetime(?1)
          )
      `)
      .bind(nowIso)
      .all<WatchRow>();
    return r.results;
  },

  async setEnabled(db: D1Database, id: string, enabled: boolean): Promise<void> {
    const now = new Date().toISOString();
    await db
      .prepare("UPDATE watches SET enabled = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(enabled ? 1 : 0, now, id)
      .run();
  },

  async update(
    db: D1Database,
    id: string,
    patch: {
      name?: string;
      interval_minutes?: number;
      match_type?: WatchMatchType;
      match_value?: string | null;
      notify_email?: string;
      notify_mode?: WatchNotifyMode;
    },
  ): Promise<WatchRow | null> {
    const existing = await this.findById(db, id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const merged = {
      name:             patch.name ?? existing.name,
      interval_minutes: patch.interval_minutes ?? existing.interval_minutes,
      match_type:       patch.match_type ?? existing.match_type,
      match_value:      patch.match_value !== undefined ? patch.match_value : existing.match_value,
      notify_email:     patch.notify_email ?? existing.notify_email,
      notify_mode:      patch.notify_mode ?? existing.notify_mode,
    };
    await db
      .prepare(`
        UPDATE watches SET
          name = ?1, interval_minutes = ?2, match_type = ?3, match_value = ?4,
          notify_email = ?5, notify_mode = ?6, updated_at = ?7
        WHERE id = ?8
      `)
      .bind(
        merged.name, merged.interval_minutes, merged.match_type, merged.match_value,
        merged.notify_email, merged.notify_mode, now, id,
      )
      .run();
    return { ...existing, ...merged, updated_at: now };
  },

  async recordCheck(
    db: D1Database,
    id: string,
    p: { hash: string | null; matched: boolean; notified: boolean; error: string | null },
  ): Promise<void> {
    const now = new Date().toISOString();
    await db
      .prepare(`
        UPDATE watches SET
          last_checked_at    = ?1,
          last_hash          = COALESCE(?2, last_hash),
          last_matched_at    = CASE WHEN ?3 = 1 THEN ?1 ELSE last_matched_at END,
          last_notified_at   = CASE WHEN ?4 = 1 THEN ?1 ELSE last_notified_at END,
          last_error         = ?5,
          consecutive_errors = CASE WHEN ?5 IS NULL THEN 0 ELSE consecutive_errors + 1 END,
          updated_at         = ?1
        WHERE id = ?6
      `)
      .bind(now, p.hash, p.matched ? 1 : 0, p.notified ? 1 : 0, p.error, id)
      .run();
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM watches WHERE id = ?").bind(id).run();
  },
};

export const watchHitQueries = {

  async insert(
    db: D1Database,
    p: { watch_id: string; snippet: string | null; page_hash: string | null; notified: boolean },
  ): Promise<string> {
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO watch_hits (id, watch_id, matched_at, snippet, page_hash, notified)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `)
      .bind(id, p.watch_id, now, p.snippet, p.page_hash, p.notified ? 1 : 0)
      .run();
    return id;
  },

  async listForWatch(db: D1Database, watchId: string, limit = 10): Promise<WatchHitRow[]> {
    const r = await db
      .prepare("SELECT * FROM watch_hits WHERE watch_id = ?1 ORDER BY matched_at DESC LIMIT ?2")
      .bind(watchId, limit)
      .all<WatchHitRow>();
    return r.results;
  },
};

// ── cleanupLogQueries ─────────────────────────────────────────

export const cleanupLogQueries = {

  async insert(
    db: D1Database,
    p: {
      action: string;
      target_type: string;
      target_id: string;
      reason?: string;
      details?: string;
      batch_id?: string;
    },
  ): Promise<string> {
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare(`
        INSERT INTO cleanup_log (id, action, target_type, target_id, reason, details, status, batch_id, proposed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'proposed', ?7, ?8)
      `)
      .bind(id, p.action, p.target_type, p.target_id, p.reason ?? null, p.details ?? null, p.batch_id ?? null, now)
      .run();
    return id;
  },

  async listPending(db: D1Database, batchId?: string): Promise<CleanupLogRow[]> {
    if (batchId) {
      const r = await db
        .prepare("SELECT * FROM cleanup_log WHERE status = 'proposed' AND batch_id = ? ORDER BY proposed_at")
        .bind(batchId)
        .all<CleanupLogRow>();
      return r.results;
    }
    const r = await db
      .prepare("SELECT * FROM cleanup_log WHERE status = 'proposed' ORDER BY proposed_at")
      .all<CleanupLogRow>();
    return r.results;
  },

  async findById(db: D1Database, id: string): Promise<CleanupLogRow | null> {
    return (await db.prepare("SELECT * FROM cleanup_log WHERE id = ?").bind(id).first<CleanupLogRow>()) ?? null;
  },

  async markApproved(db: D1Database, ids: string[]): Promise<void> {
    for (const id of ids) {
      await db.prepare("UPDATE cleanup_log SET status = 'approved' WHERE id = ? AND status = 'proposed'").bind(id).run();
    }
  },

  async markRejected(db: D1Database, ids: string[]): Promise<void> {
    for (const id of ids) {
      const now = new Date().toISOString();
      await db.prepare("UPDATE cleanup_log SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'proposed'").bind(now, id).run();
    }
  },

  async markExecuted(db: D1Database, id: string): Promise<void> {
    const now = new Date().toISOString();
    await db.prepare("UPDATE cleanup_log SET status = 'executed', resolved_at = ? WHERE id = ?").bind(now, id).run();
  },

  async listApproved(db: D1Database): Promise<CleanupLogRow[]> {
    const r = await db
      .prepare("SELECT * FROM cleanup_log WHERE status = 'approved' ORDER BY proposed_at")
      .all<CleanupLogRow>();
    return r.results;
  },
};
