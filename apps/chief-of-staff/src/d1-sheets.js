/**
 * d1-sheets.js — Cloudflare D1 adapter with the same interface as sheets.js.
 *
 * Drop-in replacement for createSheets(gfetch, spreadsheetId). Consumers
 * (tools.js, goals.js, crm.js, ingest.js, etc.) call the same methods —
 * readSheetAsObjects, findRowByKey, appendRows, updateRow — without knowing
 * whether the backing store is Google Sheets or D1.
 *
 * Factory: createD1Sheets(db) where db is the Cloudflare D1 binding (env.DB).
 */

import { SHEET_SCHEMAS } from "./bootstrap.js";

// Column list per table, used for positional array ↔ object conversion.
// Falls back to SHEET_SCHEMAS; if a table isn't listed there we discover
// columns dynamically via PRAGMA.
const COLUMNS_CACHE = new Map();

function columnsFor(tableName) {
  if (COLUMNS_CACHE.has(tableName)) return COLUMNS_CACHE.get(tableName);
  const cols = SHEET_SCHEMAS[tableName] || null;
  if (cols) COLUMNS_CACHE.set(tableName, cols);
  return cols;
}

// SQL quoting — table and column names that are reserved words (e.g. "from",
// "key", "trigger") must be double-quoted in SQL.
const RESERVED = new Set([
  "from", "key", "value", "order", "group", "index", "table", "select",
  "where", "trigger", "status", "description", "location",
]);

function q(name) {
  return RESERVED.has(name.toLowerCase()) ? `"${name}"` : name;
}

function qTable(name) {
  // Table names from SHEET_SCHEMAS are safe identifiers, but quote anyway
  // for defence-in-depth.
  return `"${name}"`;
}

/**
 * createD1Sheets(db) — returns the same interface as createSheets().
 */
export function createD1Sheets(db) {

  /**
   * Discover column names for a table we don't have in SHEET_SCHEMAS.
   * Caches the result for the lifetime of the isolate.
   */
  async function discoverColumns(tableName) {
    if (COLUMNS_CACHE.has(tableName)) return COLUMNS_CACHE.get(tableName);
    const info = await db.prepare(`PRAGMA table_info(${qTable(tableName)})`).all();
    const cols = (info.results || [])
      .filter((r) => r.name !== "_row_id")
      .sort((a, b) => a.cid - b.cid)
      .map((r) => r.name);
    COLUMNS_CACHE.set(tableName, cols);
    return cols;
  }

  /**
   * Read all rows from a table.
   * Returns { headers: string[], rows: string[][] } — same shape as sheets.js.
   */
  async function readSheet(tableName) {
    const cols = columnsFor(tableName) || await discoverColumns(tableName);
    if (!cols || cols.length === 0) return { headers: [], rows: [] };

    const colList = cols.map(q).join(", ");
    const result = await db.prepare(`SELECT ${colList} FROM ${qTable(tableName)}`).all();
    const rows = (result.results || []).map((row) =>
      cols.map((c) => (row[c] != null ? String(row[c]) : ""))
    );
    return { headers: [...cols], rows };
  }

  /**
   * Read all rows as objects keyed by column name.
   */
  async function readSheetAsObjects(tableName) {
    const cols = columnsFor(tableName) || await discoverColumns(tableName);
    if (!cols || cols.length === 0) return [];

    const colList = cols.map(q).join(", ");
    const result = await db.prepare(`SELECT ${colList} FROM ${qTable(tableName)}`).all();
    return (result.results || []).map((row) => {
      const obj = {};
      for (const c of cols) {
        obj[c] = row[c] != null ? String(row[c]) : "";
      }
      return obj;
    });
  }

  /**
   * Append rows to a table.
   * rows: array of arrays (values in column order).
   */
  async function appendRows(tableName, rows) {
    if (!rows || rows.length === 0) return;
    const cols = columnsFor(tableName) || await discoverColumns(tableName);
    if (!cols || cols.length === 0) {
      throw new Error(`appendRows: unknown table '${tableName}' — no column schema available`);
    }

    const placeholders = cols.map(() => "?").join(", ");
    const colList = cols.map(q).join(", ");
    const sql = `INSERT INTO ${qTable(tableName)} (${colList}) VALUES (${placeholders})`;

    const stmts = rows.map((row) => {
      // Pad or trim the values array to match column count.
      const vals = cols.map((_, i) => {
        const v = row[i];
        if (v == null) return "";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
      });
      return db.prepare(sql).bind(...vals);
    });

    // D1 batch is limited to 100 statements per call.
    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }
  }

  /**
   * Update a specific row by its rowNum (1-indexed, header = row 1,
   * first data row = row 2 — matching sheets.js convention).
   *
   * values can be:
   *   - An array of values in column order (canonical usage in tools.js / goals.js)
   *   - An object keyed by column name (used by ingest.js — see bug note)
   */
  async function updateRow(tableName, rowNum, values) {
    const cols = columnsFor(tableName) || await discoverColumns(tableName);
    if (!cols || cols.length === 0) {
      throw new Error(`updateRow: unknown table '${tableName}'`);
    }

    // rowNum is 1-indexed with header at row 1, so data rows start at 2.
    // _row_id is 1-indexed with no header offset.
    const rowId = rowNum - 1;

    let vals;
    if (Array.isArray(values)) {
      vals = cols.map((_, i) => {
        const v = values[i];
        if (v == null) return "";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
      });
    } else if (typeof values === "object" && values !== null) {
      // Object form — pick values by column name. Unspecified columns keep
      // their current value (we overwrite with the provided fields).
      vals = cols.map((c) => {
        const v = values[c];
        if (v === undefined) return undefined; // sentinel: skip this column
        if (v == null) return "";
        if (typeof v === "object") return JSON.stringify(v);
        return String(v);
      });
      // Build a partial UPDATE with only the provided columns.
      const setCols = [];
      const setVals = [];
      cols.forEach((c, i) => {
        if (vals[i] !== undefined) {
          setCols.push(`${q(c)} = ?`);
          setVals.push(vals[i]);
        }
      });
      if (setCols.length === 0) return;
      const sql = `UPDATE ${qTable(tableName)} SET ${setCols.join(", ")} WHERE _row_id = ?`;
      await db.prepare(sql).bind(...setVals, rowId).run();
      return;
    } else {
      throw new Error("updateRow: values must be an array or object");
    }

    const setClause = cols.map((c) => `${q(c)} = ?`).join(", ");
    const sql = `UPDATE ${qTable(tableName)} SET ${setClause} WHERE _row_id = ?`;
    await db.prepare(sql).bind(...vals, rowId).run();
  }

  /**
   * Find the first row where keyColumn === keyValue.
   * Returns { rowNum, data } (rowNum is 1-indexed) or null.
   */
  async function findRowByKey(tableName, keyColumn, keyValue) {
    const cols = columnsFor(tableName) || await discoverColumns(tableName);
    if (!cols || cols.length === 0) return null;
    if (!cols.includes(keyColumn)) return null;

    const colList = cols.map(q).join(", ");
    const sql = `SELECT _row_id, ${colList} FROM ${qTable(tableName)} WHERE ${q(keyColumn)} = ? LIMIT 1`;
    const result = await db.prepare(sql).bind(String(keyValue)).all();
    const row = (result.results || [])[0];
    if (!row) return null;

    const data = {};
    for (const c of cols) {
      data[c] = row[c] != null ? String(row[c]) : "";
    }
    return { rowNum: row._row_id + 1, data };
  }

  /**
   * Find all rows where keyColumn === keyValue.
   */
  async function findRowsByKey(tableName, keyColumn, keyValue) {
    const cols = columnsFor(tableName) || await discoverColumns(tableName);
    if (!cols || cols.length === 0) return [];
    if (!cols.includes(keyColumn)) return [];

    const colList = cols.map(q).join(", ");
    const sql = `SELECT _row_id, ${colList} FROM ${qTable(tableName)} WHERE ${q(keyColumn)} = ?`;
    const result = await db.prepare(sql).bind(String(keyValue)).all();
    return (result.results || []).map((row) => {
      const data = {};
      for (const c of cols) {
        data[c] = row[c] != null ? String(row[c]) : "";
      }
      return { rowNum: row._row_id + 1, data };
    });
  }

  /**
   * Return the list of table names (analogous to sheet tab names).
   */
  async function listSheetTabs() {
    const result = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf%' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'`
    ).all();
    return (result.results || []).map((r) => r.name);
  }

  /**
   * Create a new table if it doesn't exist. Uses SHEET_SCHEMAS if available,
   * otherwise creates a minimal table.
   */
  async function createSheetTab(title) {
    if (!title) throw new Error("createSheetTab: title is required");
    const cols = SHEET_SCHEMAS[title];
    if (cols) {
      const colDefs = cols.map((c) => `${q(c)} TEXT DEFAULT ''`).join(", ");
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS ${qTable(title)} (_row_id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs})`
      ).run();
      COLUMNS_CACHE.set(title, cols);
    } else {
      // Unknown table — create with just _row_id; caller will need to ALTER.
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS ${qTable(title)} (_row_id INTEGER PRIMARY KEY AUTOINCREMENT)`
      ).run();
    }
  }

  /**
   * Ensure the header row matches the expected columns.
   * In D1 this means adding any missing columns via ALTER TABLE.
   */
  async function setHeaderRow(tableName, headers) {
    if (!Array.isArray(headers) || headers.length === 0) return;

    // Discover existing columns.
    const info = await db.prepare(`PRAGMA table_info(${qTable(tableName)})`).all();
    const existing = new Set((info.results || []).map((r) => r.name));

    const stmts = [];
    for (const h of headers) {
      if (h === "_row_id") continue;
      if (!existing.has(h)) {
        stmts.push(
          db.prepare(`ALTER TABLE ${qTable(tableName)} ADD COLUMN ${q(h)} TEXT DEFAULT ''`)
        );
      }
    }
    if (stmts.length > 0) {
      for (const stmt of stmts) await stmt.run();
    }

    // Update cache.
    COLUMNS_CACHE.set(tableName, headers.filter((h) => h !== "_row_id"));
  }

  return {
    readSheet,
    readSheetAsObjects,
    appendRows,
    updateRow,
    findRowByKey,
    findRowsByKey,
    listSheetTabs,
    createSheetTab,
    setHeaderRow,
  };
}
