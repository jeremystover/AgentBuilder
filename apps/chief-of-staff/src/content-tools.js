/**
 * content-tools.js — Drive markdown + web/Drive content MCP tools.
 *
 * Extracted from worker.js to keep the HTTP entry point focused on routing.
 * Exposes a factory `createContentTools({ gfetch, config })` that returns:
 *   - tools: MCP tool registry (resolve_uri, read_content, search_content,
 *            list_status_files, read_status_file, write_status_file,
 *            append_status_file, delete_status_file)
 *   - loaders: { fetchWeb, gfetch } — reusable content loaders, used by
 *              `resources/read` in worker.js so cached web fetches are shared.
 *
 * Caches are module-level (isolate-scoped) to preserve the pre-extraction
 * behavior of sharing cache state across requests in the same V8 isolate.
 */

import { withRetry } from "./auth.js";
import {
  parseResourceUri,
  readContent,
  resolveUri,
  searchInText,
  fetchWebText,
} from "./content.js";

// ── Module-level caches (isolate-scoped, shared across requests) ─────────────

const sheetCache = {
  loadedAt: 0,
  ttlMs: 60_000,
  map: new Map(), // appIdLower -> folderId
};

const fileIdCache = new Map(); // key: `${folderId}::${fileName}` -> { id, updatedAtMs }
const webCache = new Map();    // uri -> { text, metadata, updatedAtMs }
const rateWindow = new Map();  // hostname -> { count, resetAt }

const ALL_DRIVES = "supportsAllDrives=true&includeItemsFromAllDrives=true";

// ── Pure utilities ───────────────────────────────────────────────────────────

function nowMs() {
  return Date.now();
}

function validateFileName(relativePath) {
  const name = String(relativePath || "").trim();
  if (!name) throw new Error("path is required");
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error("Only flat file names are supported.");
  }
  if (!/\.md$/i.test(name)) {
    throw new Error("Only .md files are supported.");
  }
  return name;
}

function cacheKey(folderId, fileName) {
  return `${folderId}::${fileName}`;
}

// ── Drive operations factory ─────────────────────────────────────────────────
// All Drive functions are constructed per-request with the request-scoped gfetch.

function createDriveOps(gfetch, config) {
  const {
    DEFAULT_FOLDER_ID,
    APPS_SHEET_ID,
    DEFAULT_SHEET_NAME,
    APP_ID,
  } = config;

  async function loadAppFolderMapFromSheet() {
    if (!APPS_SHEET_ID) return new Map();

    const n = nowMs();
    if (n - sheetCache.loadedAt < sheetCache.ttlMs && sheetCache.map.size > 0) {
      return sheetCache.map;
    }

    const range = encodeURIComponent(`${DEFAULT_SHEET_NAME}!A1:ZZ`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(APPS_SHEET_ID)}/values/${range}`;

    const res = await withRetry(() => gfetch(url));
    const json = await res.json();
    const values = json.values || [];

    const map = new Map();
    if (values.length < 2) {
      sheetCache.loadedAt = n;
      sheetCache.map = map;
      return map;
    }

    const header = values[0].map((v) => String(v || "").trim().toLowerCase());
    const appIdCol = header.findIndex((col) => col === "appid" || col === "app_id" || col === "app id");
    const folderCol = header.findIndex(
      (col) => col === "mcpdrivefolderid" || col === "mcp_drive_folder_id" || col === "mcp drive folder id"
    );

    if (appIdCol === -1 || folderCol === -1) {
      throw new Error("Apps sheet must include columns: appId and mcpDriveFolderId");
    }

    for (let i = 1; i < values.length; i++) {
      const row = values[i] || [];
      const appId = String(row[appIdCol] || "").trim().toLowerCase();
      const folderId = String(row[folderCol] || "").trim();
      if (appId && folderId) map.set(appId, folderId);
    }

    sheetCache.loadedAt = n;
    sheetCache.map = map;
    return map;
  }

  async function resolveFolderId(args = {}) {
    const appId = String(args.appId || APP_ID || "").trim();

    if (appId) {
      if (!APPS_SHEET_ID) throw new Error("PPP_MCP_APPS_SHEET_ID is not configured for appId mapping.");
      const map = await loadAppFolderMapFromSheet();
      const folderId = map.get(appId.toLowerCase()) || "";
      if (!folderId) throw new Error(`No mcpDriveFolderId configured for appId: ${appId}`);
      return { folderId, appId };
    }

    if (!DEFAULT_FOLDER_ID) {
      throw new Error("Missing PPP_MCP_DRIVE_FOLDER_ID (or provide appId + PPP_MCP_APPS_SHEET_ID mapping)");
    }
    return { folderId: DEFAULT_FOLDER_ID, appId: "" };
  }

  async function findMarkdownFileByName(folderId, fileName) {
    const escaped = fileName.replace(/'/g, "\\'");
    const q = encodeURIComponent(
      `'${folderId}' in parents and trashed=false and name='${escaped}' and mimeType='text/markdown'`
    );
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime,shortcutDetails)&orderBy=modifiedTime desc&pageSize=10&${ALL_DRIVES}`;

    const res = await withRetry(() => gfetch(url));
    const json = await res.json();
    const files = (json.files || []).filter((f) => !f.shortcutDetails);

    if (files.length > 1) {
      console.warn(`[warn] Multiple markdown files named "${fileName}" in folder ${folderId}. Using most recent.`);
    }
    return files[0] || null;
  }

  async function getOrResolveFileId(folderId, fileName) {
    const key = cacheKey(folderId, fileName);
    const cached = fileIdCache.get(key);
    if (cached?.id) return cached.id;

    const found = await findMarkdownFileByName(folderId, fileName);
    if (found?.id) {
      fileIdCache.set(key, { id: found.id, updatedAtMs: nowMs() });
      return found.id;
    }
    return "";
  }

  function invalidateFileCache(folderId, fileName) {
    fileIdCache.delete(cacheKey(folderId, fileName));
  }

  async function readMarkdownById(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&${ALL_DRIVES}`;
    const res = await withRetry(() => gfetch(url));
    return await res.text();
  }

  async function updateMarkdownById(fileId, text) {
    const url = `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`;
    await withRetry(() =>
      gfetch(url, {
        method: "PATCH",
        headers: { "content-type": "text/markdown; charset=utf-8" },
        body: text,
      })
    );
  }

  async function createMarkdownFile(folderId, fileName, text) {
    const boundary = "mcp-boundary-" + Math.random().toString(36).slice(2);
    const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: "text/markdown" });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${text}\r\n` +
      `--${boundary}--`;

    const res = await withRetry(() =>
      gfetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      })
    );
    const json = await res.json().catch(() => ({}));
    return String(json.id || "");
  }

  async function deleteFileById(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`;
    await withRetry(() => gfetch(url, { method: "DELETE" }));
  }

  async function listStatusFiles(args = {}) {
    const { folderId } = await resolveFolderId(args);
    const glob = args.glob ? String(args.glob).toLowerCase() : "";

    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='text/markdown'`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size,modifiedTime,mimeType)&orderBy=name&pageSize=1000&${ALL_DRIVES}`;

    const res = await withRetry(() => gfetch(url));
    const json = await res.json();

    const files = (json.files || [])
      .filter((f) => /\.md$/i.test(f.name))
      .filter((f) => !glob || String(f.name).toLowerCase().includes(glob))
      .map((f) => ({ path: f.name, bytes: Number(f.size || 0), updatedAt: f.modifiedTime }));

    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  }

  async function readStatusFile(args = {}) {
    const { folderId } = await resolveFolderId(args);
    const fileName = validateFileName(args.path);
    const fileId = await getOrResolveFileId(folderId, fileName);
    if (!fileId) throw new Error(`File not found: ${fileName}`);

    try {
      const text = await readMarkdownById(fileId);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("Google API 404")) {
        invalidateFileCache(folderId, fileName);
        const freshId = await getOrResolveFileId(folderId, fileName);
        if (!freshId) throw new Error(`File not found: ${fileName}`);
        const text = await readMarkdownById(freshId);
        return { content: [{ type: "text", text }] };
      }
      throw e;
    }
  }

  async function writeStatusFile(args = {}) {
    const { folderId } = await resolveFolderId(args);
    const fileName = validateFileName(args.path);
    const text = String(args.text ?? "");

    return await withRetry(async () => {
      let fileId = await getOrResolveFileId(folderId, fileName);

      if (fileId) {
        try {
          await updateMarkdownById(fileId, text);
          return { content: [{ type: "text", text: `Wrote ${text.length} chars to ${fileName}.` }] };
        } catch (e) {
          const msg = String(e?.message || "");
          if (msg.includes("Google API 404")) {
            invalidateFileCache(folderId, fileName);
            fileId = "";
          } else {
            throw e;
          }
        }
      }

      const found = await findMarkdownFileByName(folderId, fileName);
      if (found?.id) {
        fileIdCache.set(cacheKey(folderId, fileName), { id: found.id, updatedAtMs: nowMs() });
        await updateMarkdownById(found.id, text);
        return { content: [{ type: "text", text: `Wrote ${text.length} chars to ${fileName}.` }] };
      }

      const createdId = await createMarkdownFile(folderId, fileName, text);
      if (createdId) fileIdCache.set(cacheKey(folderId, fileName), { id: createdId, updatedAtMs: nowMs() });
      return { content: [{ type: "text", text: `Wrote ${text.length} chars to ${fileName}.` }] };
    });
  }

  async function appendStatusFile(args = {}) {
    const { folderId } = await resolveFolderId(args);
    const fileName = validateFileName(args.path);
    const suffix = String(args.text ?? "");

    return await withRetry(async () => {
      let fileId = await getOrResolveFileId(folderId, fileName);

      if (!fileId) {
        const createdId = await createMarkdownFile(folderId, fileName, suffix);
        if (createdId) fileIdCache.set(cacheKey(folderId, fileName), { id: createdId, updatedAtMs: nowMs() });
        return { content: [{ type: "text", text: `Appended ${suffix.length} chars to ${fileName}.` }] };
      }

      try {
        const current = await readMarkdownById(fileId);
        await updateMarkdownById(fileId, current + suffix);
        return { content: [{ type: "text", text: `Appended ${suffix.length} chars to ${fileName}.` }] };
      } catch (e) {
        const msg = String(e?.message || "");
        if (msg.includes("Google API 404")) {
          invalidateFileCache(folderId, fileName);
          const fresh = await findMarkdownFileByName(folderId, fileName);
          if (!fresh?.id) {
            const createdId = await createMarkdownFile(folderId, fileName, suffix);
            if (createdId) fileIdCache.set(cacheKey(folderId, fileName), { id: createdId, updatedAtMs: nowMs() });
            return { content: [{ type: "text", text: `Appended ${suffix.length} chars to ${fileName}.` }] };
          }
          fileIdCache.set(cacheKey(folderId, fileName), { id: fresh.id, updatedAtMs: nowMs() });
          const current = await readMarkdownById(fresh.id);
          await updateMarkdownById(fresh.id, current + suffix);
          return { content: [{ type: "text", text: `Appended ${suffix.length} chars to ${fileName}.` }] };
        }
        throw e;
      }
    });
  }

  async function deleteStatusFile(args = {}) {
    const { folderId } = await resolveFolderId(args);
    const fileName = validateFileName(args.path);
    const fileId = await getOrResolveFileId(folderId, fileName);
    if (!fileId) throw new Error(`File not found: ${fileName}`);

    try {
      await deleteFileById(fileId);
      invalidateFileCache(folderId, fileName);
      return { content: [{ type: "text", text: `Deleted ${fileName}.` }] };
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("Google API 404")) {
        invalidateFileCache(folderId, fileName);
        return { content: [{ type: "text", text: `Deleted ${fileName}.` }] };
      }
      throw e;
    }
  }

  return { listStatusFiles, readStatusFile, writeStatusFile, appendStatusFile, deleteStatusFile };
}

// ── Web fetch helpers ────────────────────────────────────────────────────────

function enforceRateLimit(hostname, limitPerMin) {
  const n = nowMs();
  const slot = rateWindow.get(hostname) || { count: 0, resetAt: n + 60_000 };
  if (n > slot.resetAt) {
    slot.count = 0;
    slot.resetAt = n + 60_000;
  }
  slot.count += 1;
  rateWindow.set(hostname, slot);
  if (slot.count > limitPerMin) {
    throw new Error(`Rate limit exceeded for host: ${hostname}`);
  }
}

async function getSourceTextForUri(uri, config) {
  const parsed = parseResourceUri(uri);
  if (parsed.kind !== "web") return null;

  const targetUrl = parsed.target;
  const host = new URL(targetUrl).hostname.toLowerCase();
  enforceRateLimit(host, config.WEB_RATE_LIMIT_PER_MIN);

  const cached = webCache.get(uri);
  if (cached && nowMs() - cached.updatedAtMs < 60_000) {
    return { text: cached.text, metadata: { ...cached.metadata, cacheHit: true } };
  }

  const fetched = await fetchWebText(targetUrl, {
    timeoutMs: config.WEB_TIMEOUT_MS,
    maxRedirects: config.WEB_MAX_REDIRECTS,
    maxBytes: config.WEB_MAX_BYTES,
    allowlist: config.WEB_ALLOWLIST,
    denylist: config.WEB_DENYLIST,
  });

  webCache.set(uri, { ...fetched, updatedAtMs: nowMs() });
  return fetched;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createContentTools({ gfetch, config }) {
  const drive = createDriveOps(gfetch, config);

  async function fetchWebViaCache(url) {
    const preloaded = await getSourceTextForUri(`web+${url}`, config);
    if (preloaded) return preloaded;
    return await fetchWebText(url, {
      timeoutMs: config.WEB_TIMEOUT_MS,
      maxRedirects: config.WEB_MAX_REDIRECTS,
      maxBytes: config.WEB_MAX_BYTES,
      allowlist: config.WEB_ALLOWLIST,
      denylist: config.WEB_DENYLIST,
    });
  }

  const loaders = { fetchWeb: fetchWebViaCache, gfetch };

  const tools = {
    resolve_uri: {
      description: "Resolve URL or Drive fileId into MCP resource URI.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          fileId: { type: "string" },
          kind: { type: "string", enum: ["gdoc", "gsheet", "gslides"] },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => resolveUri(args),
    },
    read_content: {
      description: "Read normalized content from web or Drive URI with chunking and section modes.",
      inputSchema: {
        type: "object",
        properties: {
          uri: { type: "string" },
          mode: { type: "string", enum: ["outline", "section", "full", "chunk"] },
          section: { anyOf: [{ type: "string" }, { type: "number" }] },
          chunk: { type: "number" },
          format: { type: "string" },
          include_metadata: { type: "boolean" },
        },
        required: ["uri"],
        additionalProperties: false,
      },
      run: async (args = {}) =>
        await readContent({
          ...args,
          maxChars: config.MAX_CHARS,
          loaders,
        }),
    },
    search_content: {
      description:
        "Full-text search inside the normalized body of a single URI (web page or Drive doc). " +
        "Use this when you already know the document to search. " +
        "For searching across Tasks/Commitments/Intake/Decisions records, use `search_vault` instead.",
      inputSchema: {
        type: "object",
        properties: { uri: { type: "string" }, query: { type: "string" } },
        required: ["uri", "query"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const read = await readContent({
          uri: args.uri,
          mode: "full",
          include_metadata: false,
          maxChars: Number.MAX_SAFE_INTEGER,
          loaders,
        });
        return { hits: searchInText(read.text, args.query) };
      },
    },
    list_status_files: {
      description: "List markdown files in the selected Drive folder.",
      inputSchema: {
        type: "object",
        properties: { glob: { type: "string" }, appId: { type: "string" } },
        additionalProperties: false,
      },
      run: drive.listStatusFiles,
    },
    read_status_file: {
      description: "Read a markdown status file by name.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, appId: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      run: drive.readStatusFile,
    },
    write_status_file: {
      description: "Create or overwrite a status file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" }, appId: { type: "string" } },
        required: ["path", "text"],
        additionalProperties: false,
      },
      run: drive.writeStatusFile,
    },
    append_status_file: {
      description: "Append text to a status file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, text: { type: "string" }, appId: { type: "string" } },
        required: ["path", "text"],
        additionalProperties: false,
      },
      run: drive.appendStatusFile,
    },
    delete_status_file: {
      description: "Delete a status file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, appId: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      run: drive.deleteStatusFile,
    },
  };

  // Expose `drive` so other modules (e.g. state-export.js) can write Drive
  // files through the same path the MCP tools use — shared caching, retries,
  // and file-id lookup stay consistent.
  return { tools, loaders, drive };
}
