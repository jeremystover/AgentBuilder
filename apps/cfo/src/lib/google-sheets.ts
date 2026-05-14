/**
 * Google Sheets writer for the Reporting module. Auth piggy-backs on the
 * (cfo, default) row in the cfo-tokens D1 vault — the same row used by
 * gmail.ts. The token's granted scopes must include:
 *   - https://www.googleapis.com/auth/spreadsheets
 *   - https://www.googleapis.com/auth/drive.file
 *
 * If the bootstrap only granted gmail.readonly, re-run the OAuth flow
 * with the broader scope set before the first report. See
 * docs/setup-neon.md for the walkthrough.
 */

import { D1TokenVault, importKey, type StoredGoogleToken } from '@agentbuilder/auth-google';
import type { Env } from '../types';
import type { ReportOutput, ReportSection } from './report-generator';

const AGENT_ID = 'cfo';
const DEFAULT_USER_ID = 'default';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_SKEW_MS = 60_000;
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

// Re-using the gmail.ts pattern. Duplicated rather than refactored to keep
// this commit surgical; a future PR can extract a shared google-auth lib.
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function getVault(env: Env): Promise<D1TokenVault> {
  if (!env.GOOGLE_TOKEN_VAULT_KEK) throw new Error('GOOGLE_TOKEN_VAULT_KEK is not configured.');
  const kekBytes = base64ToBytes(env.GOOGLE_TOKEN_VAULT_KEK);
  const key = await importKey(kekBytes.buffer as ArrayBuffer);
  return new D1TokenVault({ db: env.TOKENS, encryptionKey: key });
}

async function getAccessToken(env: Env): Promise<string> {
  const vault = await getVault(env);
  const stored = await vault.get({ agentId: AGENT_ID, userId: DEFAULT_USER_ID });
  if (!stored) throw new Error(`No Google token for cfo:${DEFAULT_USER_ID}. Re-auth with sheets+drive scopes.`);
  if (stored.expiresAt - REFRESH_SKEW_MS > Date.now()) return stored.accessToken;
  if (!stored.refreshToken) throw new Error('Google token expired and no refresh token available; re-authenticate.');
  return refresh(env, vault, stored);
}

async function refresh(env: Env, vault: D1TokenVault, stored: StoredGoogleToken): Promise<string> {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not set.');
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken as string,
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${await res.text()}`);
  const json = await res.json() as { access_token: string; expires_in: number; scope?: string };
  const now = Date.now();
  const fresh: StoredGoogleToken = {
    agentId: AGENT_ID,
    userId: stored.userId,
    scopes: json.scope ?? stored.scopes,
    accessToken: json.access_token,
    refreshToken: stored.refreshToken,
    expiresAt: now + json.expires_in * 1000,
    createdAt: stored.createdAt,
    updatedAt: now,
  };
  await vault.put(fresh);
  return fresh.accessToken;
}

async function gfetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken(env);
  const headers = new Headers(init.headers ?? {});
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(url, { ...init, headers });
}

// ── Sheet body assembly ─────────────────────────────────────────────────────

interface SheetCells {
  values: (string | number)[][];
  // Indices of header rows (for bold) and currency columns (for $ format).
  headerRows: number[];
  currencyColumns: number[];
}

function summaryCells(report: ReportOutput): SheetCells {
  const values: (string | number)[][] = [];
  const headerRows: number[] = [];
  values.push([report.title]);
  values.push([`Period: ${report.date_range.from} → ${report.date_range.to}`]);
  values.push([`Generated: ${report.generated_at.slice(0, 19).replace('T', ' ')} UTC`]);
  values.push([`Entities: ${report.entity_names.join(', ') || '(all)'}`]);
  if (report.unreviewed_warning_count > 0) {
    values.push([`⚠ ${report.unreviewed_warning_count} unreviewed transaction(s) in this period — excluded from totals`]);
  }
  values.push(['']);

  for (const section of report.sections) {
    headerRows.push(values.length);
    values.push([section.section_name]);
    headerRows.push(values.length);
    values.push(['Line', 'Category', 'Total']);
    for (const line of section.lines) {
      values.push([line.line_number, line.label, line.total]);
    }
    values.push(['', 'Section total', section.section_total]);
    values.push(['']);
  }

  headerRows.push(values.length);
  values.push(['Net total', '', report.net_total]);

  return { values, headerRows, currencyColumns: [2] };
}

function transactionsCells(report: ReportOutput): SheetCells {
  const values: (string | number)[][] = [];
  values.push(['Section', 'Line', 'Category', 'Date', 'Description', 'Merchant', 'Amount']);
  for (const section of report.sections) {
    for (const line of section.lines) {
      const txs = line.transactions ?? [];
      for (const tx of txs) {
        values.push([section.section_name, line.line_number, line.label, tx.date, tx.description, tx.merchant ?? '', tx.amount]);
      }
    }
  }
  return { values, headerRows: [0], currencyColumns: [6] };
}

// ── Sheets API calls ────────────────────────────────────────────────────────

interface SpreadsheetCreated {
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheets: Array<{ properties: { sheetId: number; title: string } }>;
}

export interface PublishedSheet {
  spreadsheetId: string;
  spreadsheetUrl: string;
  fileName: string;
}

export async function publishReport(env: Env, report: ReportOutput, opts: { fileName: string; folderId?: string | null; includeTransactions: boolean }): Promise<PublishedSheet> {
  const sheetTitles: string[] = ['Summary'];
  if (opts.includeTransactions) sheetTitles.push('Transactions');

  // 1. Create spreadsheet.
  const createRes = await gfetch(env, SHEETS_API, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: opts.fileName },
      sheets: sheetTitles.map(title => ({ properties: { title } })),
    }),
  });
  if (!createRes.ok) throw new Error(`Sheets create failed: ${await createRes.text()}`);
  const created = await createRes.json() as SpreadsheetCreated;

  // 2. Write values to each sheet.
  const summary = summaryCells(report);
  const valueRanges = [{ range: 'Summary!A1', majorDimension: 'ROWS', values: summary.values }];
  let txCells: SheetCells | null = null;
  if (opts.includeTransactions) {
    txCells = transactionsCells(report);
    valueRanges.push({ range: 'Transactions!A1', majorDimension: 'ROWS', values: txCells.values });
  }
  const valuesRes = await gfetch(env, `${SHEETS_API}/${created.spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: valueRanges }),
  });
  if (!valuesRes.ok) throw new Error(`Sheets values batchUpdate failed: ${await valuesRes.text()}`);

  // 3. Format: freeze header row, bold headers, currency columns.
  const summarySheetId = created.sheets[0]!.properties.sheetId;
  const txSheetId = opts.includeTransactions ? created.sheets[1]!.properties.sheetId : null;
  const requests: unknown[] = [
    freezeRow(summarySheetId, 1),
    ...bold(summarySheetId, summary.headerRows),
    currency(summarySheetId, summary.currencyColumns),
    autoResize(summarySheetId, 0, 3),
  ];
  if (txSheetId !== null && txCells) {
    requests.push(
      freezeRow(txSheetId, 1),
      ...bold(txSheetId, txCells.headerRows),
      currency(txSheetId, txCells.currencyColumns),
      autoResize(txSheetId, 0, 7),
    );
  }
  const formatRes = await gfetch(env, `${SHEETS_API}/${created.spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
  if (!formatRes.ok) throw new Error(`Sheets format batchUpdate failed: ${await formatRes.text()}`);

  // 4. Move to configured Drive folder.
  if (opts.folderId) {
    const moveRes = await gfetch(env, `${DRIVE_API}/${created.spreadsheetId}?addParents=${encodeURIComponent(opts.folderId)}&fields=id,parents`, {
      method: 'PATCH',
    });
    if (!moveRes.ok) throw new Error(`Drive move failed: ${await moveRes.text()}`);
  }

  return {
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}`,
    fileName: opts.fileName,
  };
}

// ── Sheets-API request builders ─────────────────────────────────────────────

function freezeRow(sheetId: number, rowCount: number): unknown {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: rowCount } },
      fields: 'gridProperties.frozenRowCount',
    },
  };
}

function bold(sheetId: number, rowIndices: number[]): unknown[] {
  // One repeatCell request per header row. Limited to a reasonable cap so a
  // very tall summary doesn't generate hundreds of requests.
  return rowIndices.slice(0, 50).map(rowIndex => ({
    repeatCell: {
      range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  }));
}

function currency(sheetId: number, colIndices: number[]): unknown {
  if (colIndices.length === 0) return { repeatCell: { range: { sheetId }, cell: {}, fields: 'userEnteredFormat' } };
  const col = colIndices[0]!;
  return {
    repeatCell: {
      range: { sheetId, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  };
}

function autoResize(sheetId: number, startCol: number, endCol: number): unknown {
  return {
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: 'COLUMNS', startIndex: startCol, endIndex: endCol },
    },
  };
}
