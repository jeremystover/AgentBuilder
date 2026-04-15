/**
 * sheets.js — Google Sheets API v4 helpers.
 *
 * Factory pattern: createSheets(gfetch, spreadsheetId) returns bound methods.
 * Works in Cloudflare Workers (no Node.js dependencies).
 *
 * The service account used for gfetch must have Editor access to the spreadsheet.
 */

import { withRetry } from "./auth.js";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * createSheets(gfetch, spreadsheetId) — returns Sheets helpers bound to a
 * specific spreadsheet and authenticated gfetch instance.
 */
export function createSheets(gfetch, spreadsheetId) {
  /**
   * Read all rows from a named sheet.
   * Returns { headers: string[], rows: string[][] }
   */
  async function readSheet(sheetName) {
    if (!spreadsheetId) throw new Error("spreadsheetId is not set");
    const range = encodeURIComponent(`${sheetName}!A1:ZZ`);
    const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}`;
    const res = await withRetry(() => gfetch(url));
    const json = await res.json();
    const values = json.values || [];
    if (values.length === 0) return { headers: [], rows: [] };
    return { headers: values[0] || [], rows: values.slice(1) };
  }

  /**
   * Read all rows as objects keyed by header name.
   */
  async function readSheetAsObjects(sheetName) {
    const { headers, rows } = await readSheet(sheetName);
    return rows.map((row) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] ?? "";
      });
      return obj;
    });
  }

  /**
   * Append rows to a named sheet.
   * rows: array of arrays (values in header column order).
   */
  async function appendRows(sheetName, rows) {
    if (!spreadsheetId) throw new Error("spreadsheetId is not set");
    if (!rows || rows.length === 0) return;
    const range = encodeURIComponent(`${sheetName}!A1`);
    const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    await withRetry(() =>
      gfetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: rows }),
      })
    );
  }

  /**
   * Update a specific row (1-indexed; header = row 1, first data = row 2).
   */
  async function updateRow(sheetName, rowNum, values) {
    if (!spreadsheetId) throw new Error("spreadsheetId is not set");
    const range = encodeURIComponent(`${sheetName}!A${rowNum}`);
    const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=USER_ENTERED`;
    await withRetry(() =>
      gfetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: [values] }),
      })
    );
  }

  /**
   * Find the first row where keyColumn === keyValue.
   * Returns { rowNum, data } (rowNum is 1-indexed) or null.
   */
  async function findRowByKey(sheetName, keyColumn, keyValue) {
    const { headers, rows } = await readSheet(sheetName);
    const colIdx = headers.indexOf(keyColumn);
    if (colIdx === -1) return null;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][colIdx] ?? "") === String(keyValue)) {
        const obj = {};
        headers.forEach((h, j) => {
          obj[h] = rows[i][j] ?? "";
        });
        return { rowNum: i + 2, data: obj };
      }
    }
    return null;
  }

  /**
   * Find all rows where keyColumn === keyValue.
   */
  async function findRowsByKey(sheetName, keyColumn, keyValue) {
    const { headers, rows } = await readSheet(sheetName);
    const colIdx = headers.indexOf(keyColumn);
    if (colIdx === -1) return [];
    return rows
      .map((row, i) => {
        if (String(row[colIdx] ?? "") === String(keyValue)) {
          const obj = {};
          headers.forEach((h, j) => {
            obj[h] = row[j] ?? "";
          });
          return { rowNum: i + 2, data: obj };
        }
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Return the list of tab (worksheet) names for this spreadsheet.
   * Uses spreadsheets.get with a fields mask so we only fetch metadata.
   */
  async function listSheetTabs() {
    if (!spreadsheetId) throw new Error("spreadsheetId is not set");
    const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`;
    const res = await withRetry(() => gfetch(url));
    const json = await res.json();
    const sheets = Array.isArray(json.sheets) ? json.sheets : [];
    return sheets.map((s) => s?.properties?.title).filter(Boolean);
  }

  /**
   * Create a new tab in the spreadsheet with the given name. No-op if it
   * already exists (caller should check first via listSheetTabs if avoiding
   * the API round trip matters).
   */
  async function createSheetTab(title) {
    if (!spreadsheetId) throw new Error("spreadsheetId is not set");
    if (!title) throw new Error("createSheetTab: title is required");
    const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
    await withRetry(() =>
      gfetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title } } }],
        }),
      })
    );
  }

  /**
   * Overwrite row 1 of a sheet with the given headers. The Sheets API extends
   * the range automatically based on values length, so callers should pass the
   * FULL intended header row (preserving any existing columns they want kept).
   */
  async function setHeaderRow(sheetName, headers) {
    if (!spreadsheetId) throw new Error("spreadsheetId is not set");
    if (!Array.isArray(headers) || headers.length === 0) {
      throw new Error("setHeaderRow: headers must be a non-empty array");
    }
    const range = encodeURIComponent(`${sheetName}!A1`);
    const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}?valueInputOption=RAW`;
    await withRetry(() =>
      gfetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: [headers] }),
      })
    );
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
