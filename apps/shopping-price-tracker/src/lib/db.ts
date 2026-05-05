import type {
  DigestRecipient,
  DigestRun,
  FlightConstraints,
  PriceObservation,
  Priority,
  Status,
  TrackedItem,
} from "../types";
import { nowIso } from "./time";

interface ItemRow {
  id: string;
  kind: "product" | "flight";
  title: string;
  description: string;
  model_number: string;
  query_strings: string;
  retailers: string;
  watch_urls: string;
  fb_locations: string | null;
  target_price_cents: number | null;
  max_price_cents: number | null;
  currency: string;
  notes: string;
  priority: Priority;
  status: Status;
  created_at: string;
  updated_at: string;
}

interface FlightRow {
  item_id: string;
  origin: string;
  destination: string;
  depart_start: string;
  depart_end: string;
  return_start: string | null;
  return_end: string | null;
  nonstop: number;
  cabin: FlightConstraints["cabin"];
  pax: number;
  max_stops: number | null;
}

interface ObservationRow {
  id: string;
  item_id: string;
  source: string;
  listing_title: string;
  listing_url: string;
  price_cents: number;
  shipping_cents: number | null;
  currency: string;
  in_stock: number | null;
  sale_flag: number;
  raw_json: string | null;
  observed_at: string;
}

interface DigestRunRow {
  id: string;
  ran_at: string;
  item_count: number;
  email_status: DigestRun["email_status"];
  email_error: string | null;
  summary_md: string;
  summary_html: string;
}

function parseStringArray(json: string): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rowToItem(row: ItemRow): TrackedItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description ?? "",
    model_number: row.model_number ?? "",
    query_strings: parseStringArray(row.query_strings),
    retailers: parseStringArray(row.retailers),
    watch_urls: parseStringArray(row.watch_urls),
    fb_locations: row.fb_locations === null ? null : parseStringArray(row.fb_locations),
    target_price_cents: row.target_price_cents,
    max_price_cents: row.max_price_cents,
    currency: row.currency,
    notes: row.notes ?? "",
    priority: row.priority,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToFlight(row: FlightRow): FlightConstraints {
  return {
    item_id: row.item_id,
    origin: row.origin,
    destination: row.destination,
    depart_start: row.depart_start,
    depart_end: row.depart_end,
    return_start: row.return_start,
    return_end: row.return_end,
    nonstop: row.nonstop === 1,
    cabin: row.cabin,
    pax: row.pax,
    max_stops: row.max_stops,
  };
}

function rowToObservation(row: ObservationRow): PriceObservation {
  return {
    id: row.id,
    item_id: row.item_id,
    source: row.source,
    listing_title: row.listing_title ?? "",
    listing_url: row.listing_url ?? "",
    price_cents: row.price_cents,
    shipping_cents: row.shipping_cents,
    currency: row.currency,
    in_stock: row.in_stock === null ? null : row.in_stock === 1,
    sale_flag: row.sale_flag === 1,
    raw_json: row.raw_json,
    observed_at: row.observed_at,
  };
}

function rowToDigest(row: DigestRunRow): DigestRun {
  return {
    id: row.id,
    ran_at: row.ran_at,
    item_count: row.item_count,
    email_status: row.email_status,
    email_error: row.email_error,
    summary_md: row.summary_md ?? "",
    summary_html: row.summary_html ?? "",
  };
}

// ── Items ──────────────────────────────────────────────────────────────────────

export const itemQueries = {
  async create(db: D1Database, item: TrackedItem): Promise<void> {
    await db
      .prepare(
        `INSERT INTO tracked_items (id, kind, title, description, model_number, query_strings, retailers, watch_urls,
            fb_locations, target_price_cents, max_price_cents, currency, notes, priority, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        item.id,
        item.kind,
        item.title,
        item.description,
        item.model_number,
        JSON.stringify(item.query_strings),
        JSON.stringify(item.retailers),
        JSON.stringify(item.watch_urls),
        item.fb_locations === null ? null : JSON.stringify(item.fb_locations),
        item.target_price_cents,
        item.max_price_cents,
        item.currency,
        item.notes,
        item.priority,
        item.status,
        item.created_at,
        item.updated_at,
      )
      .run();
  },

  async findById(db: D1Database, id: string): Promise<TrackedItem | null> {
    const row = await db
      .prepare("SELECT * FROM tracked_items WHERE id = ?")
      .bind(id)
      .first<ItemRow>();
    return row ? rowToItem(row) : null;
  },

  async list(
    db: D1Database,
    opts: { status?: Status; kind?: "product" | "flight"; priority?: Priority } = {},
  ): Promise<TrackedItem[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts.priority) {
      where.push("priority = ?");
      args.push(opts.priority);
    }
    const sql = `SELECT * FROM tracked_items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    const res = await db
      .prepare(sql)
      .bind(...args)
      .all<ItemRow>();
    return (res.results ?? []).map(rowToItem);
  },

  async update(
    db: D1Database,
    id: string,
    patch: Partial<Omit<TrackedItem, "id" | "kind" | "created_at">>,
  ): Promise<TrackedItem | null> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const map: Record<string, unknown> = {
      title: patch.title,
      description: patch.description,
      model_number: patch.model_number,
      query_strings: patch.query_strings ? JSON.stringify(patch.query_strings) : undefined,
      retailers: patch.retailers ? JSON.stringify(patch.retailers) : undefined,
      watch_urls: patch.watch_urls ? JSON.stringify(patch.watch_urls) : undefined,
      fb_locations:
        patch.fb_locations === undefined
          ? undefined
          : patch.fb_locations === null
            ? null
            : JSON.stringify(patch.fb_locations),
      target_price_cents: patch.target_price_cents,
      max_price_cents: patch.max_price_cents,
      currency: patch.currency,
      notes: patch.notes,
      priority: patch.priority,
      status: patch.status,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        sets.push(`${col} = ?`);
        args.push(val);
      }
    }
    if (sets.length === 0) return await this.findById(db, id);
    sets.push("updated_at = ?");
    args.push(nowIso());
    args.push(id);
    await db
      .prepare(`UPDATE tracked_items SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...args)
      .run();
    return await this.findById(db, id);
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM tracked_items WHERE id = ?").bind(id).run();
  },
};

// ── Flight constraints ─────────────────────────────────────────────────────────

export const flightQueries = {
  async upsert(db: D1Database, fc: FlightConstraints): Promise<void> {
    await db
      .prepare(
        `INSERT INTO flight_constraints (item_id, origin, destination, depart_start, depart_end,
            return_start, return_end, nonstop, cabin, pax, max_stops)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           origin=excluded.origin, destination=excluded.destination,
           depart_start=excluded.depart_start, depart_end=excluded.depart_end,
           return_start=excluded.return_start, return_end=excluded.return_end,
           nonstop=excluded.nonstop, cabin=excluded.cabin,
           pax=excluded.pax, max_stops=excluded.max_stops`,
      )
      .bind(
        fc.item_id,
        fc.origin,
        fc.destination,
        fc.depart_start,
        fc.depart_end,
        fc.return_start,
        fc.return_end,
        fc.nonstop ? 1 : 0,
        fc.cabin,
        fc.pax,
        fc.max_stops,
      )
      .run();
  },

  async findByItem(db: D1Database, itemId: string): Promise<FlightConstraints | null> {
    const row = await db
      .prepare("SELECT * FROM flight_constraints WHERE item_id = ?")
      .bind(itemId)
      .first<FlightRow>();
    return row ? rowToFlight(row) : null;
  },
};

// ── Observations ───────────────────────────────────────────────────────────────

export const observationQueries = {
  async insert(db: D1Database, obs: PriceObservation): Promise<void> {
    await db
      .prepare(
        `INSERT INTO price_observations (id, item_id, source, listing_title, listing_url,
            price_cents, shipping_cents, currency, in_stock, sale_flag, raw_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        obs.id,
        obs.item_id,
        obs.source,
        obs.listing_title,
        obs.listing_url,
        obs.price_cents,
        obs.shipping_cents,
        obs.currency,
        obs.in_stock === null ? null : obs.in_stock ? 1 : 0,
        obs.sale_flag ? 1 : 0,
        obs.raw_json,
        obs.observed_at,
      )
      .run();
  },

  async insertMany(db: D1Database, observations: PriceObservation[]): Promise<void> {
    if (observations.length === 0) return;
    const stmt = db.prepare(
      `INSERT INTO price_observations (id, item_id, source, listing_title, listing_url,
          price_cents, shipping_cents, currency, in_stock, sale_flag, raw_json, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const batch = observations.map((o) =>
      stmt.bind(
        o.id,
        o.item_id,
        o.source,
        o.listing_title,
        o.listing_url,
        o.price_cents,
        o.shipping_cents,
        o.currency,
        o.in_stock === null ? null : o.in_stock ? 1 : 0,
        o.sale_flag ? 1 : 0,
        o.raw_json,
        o.observed_at,
      ),
    );
    await db.batch(batch);
  },

  async listForItem(
    db: D1Database,
    itemId: string,
    opts: { since?: string; limit?: number } = {},
  ): Promise<PriceObservation[]> {
    const where: string[] = ["item_id = ?"];
    const args: unknown[] = [itemId];
    if (opts.since) {
      where.push("observed_at >= ?");
      args.push(opts.since);
    }
    const limit = opts.limit ?? 200;
    const sql = `SELECT * FROM price_observations WHERE ${where.join(" AND ")} ORDER BY observed_at DESC LIMIT ?`;
    args.push(limit);
    const res = await db
      .prepare(sql)
      .bind(...args)
      .all<ObservationRow>();
    return (res.results ?? []).map(rowToObservation);
  },

  async deleteForItem(db: D1Database, itemId: string): Promise<void> {
    await db.prepare("DELETE FROM price_observations WHERE item_id = ?").bind(itemId).run();
  },
};

// ── Digest runs ────────────────────────────────────────────────────────────────

export const digestRunQueries = {
  async insert(db: D1Database, run: DigestRun): Promise<void> {
    await db
      .prepare(
        `INSERT INTO digest_runs (id, ran_at, item_count, email_status, email_error, summary_md, summary_html)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.id,
        run.ran_at,
        run.item_count,
        run.email_status,
        run.email_error,
        run.summary_md,
        run.summary_html,
      )
      .run();
  },

  async updateStatus(
    db: D1Database,
    id: string,
    status: DigestRun["email_status"],
    error: string | null,
  ): Promise<void> {
    await db
      .prepare("UPDATE digest_runs SET email_status = ?, email_error = ? WHERE id = ?")
      .bind(status, error, id)
      .run();
  },

  async list(db: D1Database, limit = 30): Promise<DigestRun[]> {
    const res = await db
      .prepare("SELECT * FROM digest_runs ORDER BY ran_at DESC LIMIT ?")
      .bind(limit)
      .all<DigestRunRow>();
    return (res.results ?? []).map(rowToDigest);
  },

  async findById(db: D1Database, id: string): Promise<DigestRun | null> {
    const row = await db
      .prepare("SELECT * FROM digest_runs WHERE id = ?")
      .bind(id)
      .first<DigestRunRow>();
    return row ? rowToDigest(row) : null;
  },

  async latest(db: D1Database): Promise<DigestRun | null> {
    const row = await db
      .prepare("SELECT * FROM digest_runs ORDER BY ran_at DESC LIMIT 1")
      .first<DigestRunRow>();
    return row ? rowToDigest(row) : null;
  },
};

// ── Recipients ─────────────────────────────────────────────────────────────────

export const recipientQueries = {
  async list(db: D1Database): Promise<DigestRecipient[]> {
    const res = await db
      .prepare("SELECT * FROM digest_recipients ORDER BY added_at ASC")
      .all<DigestRecipient>();
    return res.results ?? [];
  },

  async add(db: D1Database, email: string): Promise<void> {
    await db
      .prepare("INSERT OR IGNORE INTO digest_recipients (email, added_at) VALUES (?, ?)")
      .bind(email.toLowerCase(), nowIso())
      .run();
  },

  async remove(db: D1Database, email: string): Promise<void> {
    await db
      .prepare("DELETE FROM digest_recipients WHERE email = ?")
      .bind(email.toLowerCase())
      .run();
  },
};
