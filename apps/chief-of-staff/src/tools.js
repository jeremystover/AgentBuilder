/**
 * tools.js — Phase 1 chief-of-staff MCP tools.
 *
 * Fixes the drift problem by enforcing:
 *   1. Hydration-first: every planning tool requires calling hydrate_planning_context first.
 *   2. Source citations: every task/commitment creation requires at least one source entry.
 *   3. Diff-based changesets: mutations are propose → review → commit (never auto-applied).
 *   4. IntakeQueue: inbound items are typed rows, not markdown blobs.
 *
 * Factory: createTools({ spreadsheetId, sheets }) returns the TOOLS object.
 * Works in Cloudflare Workers (no Node.js dependencies).
 */

// ── Durable pending-state stores ─────────────────────────────────────────────
// Pending changesets live in the `Changesets` sheet with status='pending'.
// Planning-context tokens live in the `Config` sheet under a prefixed key.
// Persisting to Sheets means propose_* → commit_changeset survives Worker
// isolate cold restarts (propose and commit may land on different isolates).
//
// A hot isolate-scoped cache avoids the extra round-trip on the happy path
// where propose and commit run in the same isolate.
const CHANGESET_TTL_MS = 10 * 60 * 1000;
const PLANNING_CONTEXT_TTL_MS = 15 * 60 * 1000;
const PLANNING_CONTEXT_KEY_PREFIX = "planningContext:";

const _changesetCache = new Map(); // changesetId -> cs (+ _rowNum for updates)
const _contextCache = new Map();   // token -> { token, hydratedAt, range, expiresAtMs }

function generateId(prefix = "cs") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeParseArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * createTools({ spreadsheetId, sheets }) — returns the MCP TOOLS registry.
 *
 * @param {string} spreadsheetId - Google Sheets spreadsheet ID
 * @param {object} sheets - result of createSheets(gfetch, spreadsheetId)
 */
export function createTools({ spreadsheetId, sheets }) {
  const { readSheetAsObjects, appendRows, findRowByKey, updateRow } = sheets;

  // ── Changeset store (persisted in the Changesets sheet) ─────────────────
  //
  // Column layout (must match the `Changesets` sheet headers):
  //   changesetId, kind, status, proposedAt, proposedBy,
  //   addsJson, updatesJson, deletesJson, appliedAt, appliedBy
  //
  // Lifecycle:
  //   propose_*        → appendRow with status='pending'
  //   commit_changeset → findRowByKey → updateRow with status='applied'
  // Expiry is proposedAt + CHANGESET_TTL_MS (no separate column needed).

  function changesetRow(cs, status, appliedBy) {
    return [
      cs.changesetId,
      cs.kind || "",
      status,
      cs.proposedAt || "",
      "claude",
      JSON.stringify(cs.adds || []),
      JSON.stringify(cs.updates || []),
      JSON.stringify(cs.deletes || []),
      status === "applied" ? new Date().toISOString() : "",
      status === "applied" ? (appliedBy || "claude") : "",
    ];
  }

  async function storeChangeset(kind, adds, updates, deletes) {
    const changesetId = generateId("cs");
    const proposedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CHANGESET_TTL_MS).toISOString();
    const cs = {
      changesetId,
      kind,
      adds: adds || [],
      updates: updates || [],
      deletes: deletes || [],
      proposedAt,
      expiresAt,
    };

    if (spreadsheetId) {
      // Propagate persistence failures — if we can't write to the Changesets
      // sheet (missing tab, bad headers, permission error) the caller must
      // see it immediately. Silently caching in-isolate is how we ended up
      // with "Changeset not found or expired" on commit: propose succeeds in
      // isolate A, commit runs in isolate B, cache misses, fallback reads a
      // sheet that doesn't exist and returns null. Run bootstrap_sheets to
      // fix the schema, then retry.
      try {
        await appendRows("Changesets", [changesetRow(cs, "pending", "")]);
      } catch (e) {
        console.error("[tools] Failed to persist pending changeset:", e.message);
        throw new Error(
          `Failed to persist changeset to 'Changesets' sheet: ${e.message}. ` +
          `Run /internal/bootstrap-sheets (or the bootstrap_sheets tool) to ` +
          `verify/repair the sheet schema.`
        );
      }
    }

    _changesetCache.set(changesetId, cs);
    return cs;
  }

  async function getChangeset(changesetId) {
    // Hot cache hit — propose and commit in the same isolate.
    const cached = _changesetCache.get(changesetId);
    if (cached) {
      if (new Date(cached.expiresAt) < new Date()) {
        _changesetCache.delete(changesetId);
      } else {
        return cached;
      }
    }

    // Fall back to persisted store — survives isolate cold restart.
    if (!spreadsheetId) return null;
    let found;
    try {
      found = await findRowByKey("Changesets", "changesetId", changesetId);
    } catch (e) {
      // Propagate read failures. A missing 'Changesets' tab or bad headers
      // will surface here and the caller (commit_changeset) should report a
      // clear error instead of pretending the changeset expired.
      console.error("[tools] Failed to read pending changeset:", e.message);
      throw new Error(
        `Failed to read 'Changesets' sheet: ${e.message}. ` +
        `Run /internal/bootstrap-sheets (or the bootstrap_sheets tool) to ` +
        `verify/repair the sheet schema.`
      );
    }
    if (!found) return null;

    const row = found.data || {};
    if (row.status !== "pending") return null;
    const proposedAtMs = Date.parse(row.proposedAt || "");
    if (!Number.isFinite(proposedAtMs)) return null;
    const expiresAtMs = proposedAtMs + CHANGESET_TTL_MS;
    if (Date.now() > expiresAtMs) return null;

    const cs = {
      changesetId,
      kind: row.kind || "",
      adds: safeParseArray(row.addsJson),
      updates: safeParseArray(row.updatesJson),
      deletes: safeParseArray(row.deletesJson),
      proposedAt: row.proposedAt || "",
      expiresAt: new Date(expiresAtMs).toISOString(),
      _rowNum: found.rowNum,
    };
    _changesetCache.set(changesetId, cs);
    return cs;
  }

  async function markChangesetApplied(cs, appliedBy) {
    // Best-effort — a warning here does NOT fail the commit. The task writes
    // already succeeded; a stale 'pending' row is a cosmetic audit gap, not
    // a data integrity issue. Same semantics as the previous audit logger.
    _changesetCache.delete(cs.changesetId);
    if (!spreadsheetId) return;
    try {
      let rowNum = cs._rowNum;
      if (rowNum == null) {
        const found = await findRowByKey("Changesets", "changesetId", cs.changesetId);
        if (!found) return;
        rowNum = found.rowNum;
      }
      await updateRow("Changesets", rowNum, changesetRow(cs, "applied", appliedBy));
    } catch (e) {
      console.warn("[tools] Failed to mark changeset applied:", e.message);
    }
  }

  // ── Planning-context store (persisted in the Config sheet) ──────────────
  //
  // Key: `planningContext:<token>`, value: JSON { hydratedAt, range, expiresAtMs }
  // Expiry is carried inside the JSON payload; the sheet's `updatedAt`
  // column is informational only.

  async function persistPlanningContext({ token, hydratedAt, range }) {
    const expiresAtMs = Date.now() + PLANNING_CONTEXT_TTL_MS;
    const record = { token, hydratedAt, range, expiresAtMs };
    _contextCache.set(token, record);

    if (spreadsheetId) {
      try {
        const key = PLANNING_CONTEXT_KEY_PREFIX + token;
        const value = JSON.stringify({ hydratedAt, range, expiresAtMs });
        await appendRows("Config", [[key, value, new Date().toISOString()]]);
      } catch (e) {
        console.warn("[tools] Failed to persist planning context:", e.message);
      }
    }

    return new Date(expiresAtMs).toISOString();
  }

  async function validatePlanningContextToken(token) {
    if (!token || typeof token !== "string") {
      return {
        ok: false,
        error: {
          code: "MISSING_CONTEXT_TOKEN",
          message: "contextToken is required. Call hydrate_planning_context first.",
        },
      };
    }

    let record = _contextCache.get(token);
    if (!record && spreadsheetId) {
      try {
        const found = await findRowByKey("Config", "key", PLANNING_CONTEXT_KEY_PREFIX + token);
        if (found) {
          try {
            const parsed = JSON.parse(found.data?.value || "{}");
            if (parsed && typeof parsed === "object") {
              record = {
                token,
                hydratedAt: parsed.hydratedAt,
                range: parsed.range,
                expiresAtMs: parsed.expiresAtMs,
              };
              _contextCache.set(token, record);
            }
          } catch { /* unparseable — treat as missing */ }
        }
      } catch (e) {
        console.warn("[tools] Failed to read planning context:", e.message);
      }
    }

    if (!record) {
      return {
        ok: false,
        error: {
          code: "INVALID_CONTEXT_TOKEN",
          message: "contextToken is invalid or no longer available. Call hydrate_planning_context again.",
        },
      };
    }
    if (!Number.isFinite(record.expiresAtMs) || record.expiresAtMs <= Date.now()) {
      _contextCache.delete(token);
      return {
        ok: false,
        error: {
          code: "STALE_CONTEXT_TOKEN",
          message: "contextToken has expired. Call hydrate_planning_context again to refresh planning state.",
        },
      };
    }
    return { ok: true, context: record };
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  function nowIso() {
    return new Date().toISOString();
  }

  function isOpen(status) {
    const s = String(status || "").toLowerCase();
    return !s || s === "open" || s === "in_progress" || s === "pending" || s === "todo";
  }

  function daysBetween(a, b) {
    return Math.round((new Date(b) - new Date(a)) / 86400000);
  }

  function formatContent(obj) {
    return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
  }

  function scoreMatch(text, query) {
    if (!text || !query) return 0;
    const t = String(text).toLowerCase();
    const q = String(query).toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const hits = terms.filter((term) => t.includes(term)).length;
    return hits / terms.length;
  }

  // ── Tool definitions ─────────────────────────────────────────────────────

  const TOOLS = {

    // ── hydrate_planning_context ──────────────────────────────────────────
    hydrate_planning_context: {
      description:
        "ALWAYS call this first before any planning, todo, EOD dump, or review tool. " +
        "Reads the current state from Sheets (open tasks, commitments, pending intake) and returns " +
        "a structured context summary + a contextToken. Pass contextToken to downstream tools. " +
        "Without hydration, the agent is working from stale memory — this is what causes drift.",
      inputSchema: {
        type: "object",
        properties: {
          range: {
            type: "string",
            enum: ["today", "week", "month", "all"],
            description: "How much calendar/task history to include. Default: today.",
          },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!spreadsheetId) {
          return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set — cannot read from Sheets." });
        }

        const range = args.range || "today";
        const now = new Date();
        const contextToken = generateId("ctx");
        const hydratedAt = nowIso();

        let tasks = [], commitments = [], intake = [];
        // Collect read failures so the caller sees them. Silently swallowing
        // these hides missing tabs / bad headers / permission errors and
        // makes every downstream tool look "empty" instead of "broken".
        const warnings = [];

        try { tasks = await readSheetAsObjects("Tasks"); }
        catch (e) {
          console.warn("hydrate: tasks read failed", e.message);
          warnings.push({ sheet: "Tasks", message: e.message });
        }
        try { commitments = await readSheetAsObjects("Commitments"); }
        catch (e) {
          console.warn("hydrate: commitments read failed", e.message);
          warnings.push({ sheet: "Commitments", message: e.message });
        }
        try { intake = await readSheetAsObjects("IntakeQueue"); }
        catch (e) {
          console.warn("hydrate: intake read failed", e.message);
          warnings.push({ sheet: "IntakeQueue", message: e.message });
        }

        const openTasks = tasks.filter((t) => isOpen(t.status));
        const myCommitments = commitments.filter((c) => String(c.ownerType) === "me" && isOpen(c.status));
        const theirCommitments = commitments.filter((c) => String(c.ownerType) === "other" && isOpen(c.status));
        const pendingIntake = intake.filter((i) => String(i.status) === "pending");

        const overdueTasks = openTasks.filter((t) => t.dueAt && new Date(t.dueAt) < now);
        const overdueCommitments = myCommitments.filter((c) => c.dueAt && new Date(c.dueAt) < now);

        const summary = {
          contextToken,
          hydratedAt,
          range,
          counts: {
            openTasks: openTasks.length,
            overdueTasks: overdueTasks.length,
            myOpenCommitments: myCommitments.length,
            overdueCommitments: overdueCommitments.length,
            theirOpenCommitments: theirCommitments.length,
            pendingIntake: pendingIntake.length,
          },
          openTasks: openTasks.slice(0, 30).map((t) => ({
            taskKey: t.taskKey,
            title: t.title || t.subject,
            status: t.status,
            priority: t.priority,
            dueAt: t.dueAt,
            projectId: t.projectId,
            overdue: !!(t.dueAt && new Date(t.dueAt) < now),
          })),
          myCommitments: myCommitments.slice(0, 20).map((c) => ({
            commitmentId: c.commitmentId,
            description: c.description,
            dueAt: c.dueAt,
            ownerId: c.ownerId,
            overdue: !!(c.dueAt && new Date(c.dueAt) < now),
            sourceType: c.sourceType,
            sourceRef: c.sourceRef,
          })),
          theirCommitments: theirCommitments.slice(0, 10).map((c) => ({
            commitmentId: c.commitmentId,
            description: c.description,
            dueAt: c.dueAt,
            ownerId: c.ownerId,
            overdue: !!(c.dueAt && new Date(c.dueAt) < now),
          })),
          pendingIntake: pendingIntake.slice(0, 20).map((i) => ({
            intakeId: i.intakeId,
            kind: i.kind,
            summary: i.summary,
            sourceRef: i.sourceRef,
            createdAt: i.createdAt,
          })),
        };

        const expiresAt = await persistPlanningContext({ token: contextToken, hydratedAt, range });
        return formatContent({
          ...summary,
          contextExpiresAt: expiresAt,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      },
    },

    // ── show_source ───────────────────────────────────────────────────────
    show_source: {
      description:
        "Return the raw sheet row (IntakeQueue/TaskSources/Commitments) for a known sourceRef. " +
        "Use this to surface the exact evidence behind a task or commitment the agent is citing. " +
        "For free-text search across sheets use `search_vault`; for text inside a URI use `search_content`.",
      inputSchema: {
        type: "object",
        properties: {
          sourceType: {
            type: "string",
            enum: ["intake", "task_source", "commitment"],
            description: "Which sheet to look up the source in.",
          },
          sourceRef: {
            type: "string",
            description: "The ID of the source (intakeId, sourceId, or commitmentId).",
          },
        },
        required: ["sourceType", "sourceRef"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const { sourceType, sourceRef } = args;
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

        try {
          let result = null;
          if (sourceType === "intake") {
            result = await findRowByKey("IntakeQueue", "intakeId", sourceRef);
          } else if (sourceType === "task_source") {
            result = await findRowByKey("TaskSources", "sourceId", sourceRef);
          } else if (sourceType === "commitment") {
            result = await findRowByKey("Commitments", "commitmentId", sourceRef);
          }

          if (!result) {
            return formatContent({ error: `Not found: ${sourceType} ${sourceRef}` });
          }

          return formatContent({
            sourceType,
            sourceRef,
            data: result.data,
            payload: result.data.payloadJson
              ? (() => { try { return JSON.parse(result.data.payloadJson); } catch { return result.data.payloadJson; } })()
              : undefined,
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── search_vault ──────────────────────────────────────────────────────
    search_vault: {
      description:
        "Search structured sheet records (Tasks, Commitments, IntakeQueue, Notes) for a query. " +
        "Use this instead of relying on memory to find relevant context. " +
        "Returns ranked hits with sourceType and sourceRef for citation. " +
        "For searching text inside a specific web page or Drive doc use `search_content`.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms (space-separated)." },
          types: {
            type: "array",
            items: { type: "string", enum: ["tasks", "commitments", "intake", "notes"] },
            description: "Sheets to search. Omit to search all.",
          },
          limit: { type: "number", description: "Max hits per sheet. Default 10." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
        const { query, types, limit = 10 } = args;
        const searchTypes = types && types.length ? types : ["tasks", "commitments", "intake", "notes"];
        const hits = [];

        const search = async (sheetName, displayType, textFields, idField) => {
          try {
            const rows = await readSheetAsObjects(sheetName);
            rows
              .map((row) => {
                const text = textFields.map((f) => String(row[f] || "")).join(" ");
                const score = scoreMatch(text, query);
                return { score, row };
              })
              .filter(({ score }) => score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, limit)
              .forEach(({ score, row }) => {
                hits.push({
                  sourceType: displayType,
                  sourceRef: row[idField] || "",
                  score: Math.round(score * 100) / 100,
                  summary: textFields.map((f) => row[f]).filter(Boolean).join(" | ").slice(0, 200),
                });
              });
          } catch (e) {
            console.warn(`search_vault: ${sheetName} failed`, e.message);
          }
        };

        if (searchTypes.includes("tasks")) await search("Tasks", "task", ["title", "subject", "notes"], "taskKey");
        if (searchTypes.includes("commitments")) await search("Commitments", "commitment", ["description", "excerpt"], "commitmentId");
        if (searchTypes.includes("intake")) await search("IntakeQueue", "intake", ["summary", "payloadJson"], "intakeId");
        if (searchTypes.includes("notes")) await search("Notes", "note", ["title", "note"], "noteId");

        hits.sort((a, b) => b.score - a.score);
        return formatContent({ query, totalHits: hits.length, hits: hits.slice(0, limit * searchTypes.length) });
      },
    },

    // ── get_intake ────────────────────────────────────────────────────────
    get_intake: {
      description:
        "Get pending items from the IntakeQueue (emails, calendar changes, meeting notes, drive changes). " +
        "This is the agent's inbox — process these items to create tasks and commitments. " +
        "Call show_source on any item to see its full payload before acting.",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["email", "calendar_added", "calendar_modified", "calendar_deleted", "drive", "meeting_note", "watchlist"],
            description: "Filter by kind. Omit to get all pending.",
          },
          limit: { type: "number", description: "Max items to return. Default 20." },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
        try {
          const rows = await readSheetAsObjects("IntakeQueue");
          let pending = rows.filter((r) => String(r.status) === "pending");
          if (args.kind) pending = pending.filter((r) => r.kind === args.kind);
          const limit = args.limit || 20;
          return formatContent({
            count: pending.length,
            items: pending.slice(0, limit).map((r) => ({
              intakeId: r.intakeId,
              kind: r.kind,
              summary: r.summary,
              sourceRef: r.sourceRef,
              createdAt: r.createdAt,
            })),
            note: "Call show_source({sourceType:'intake', sourceRef: intakeId}) to see full payload.",
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── get_prioritized_todo ──────────────────────────────────────────────
    get_prioritized_todo: {
      description:
        "Return a ranked todo list for a time range. REQUIRES hydrate_planning_context to have been called first. " +
        "Priority is based on: due date proximity, overdue commitments, explicit priority field. " +
        "Every item includes its sourceRef for citation — no tasks from memory.",
      inputSchema: {
        type: "object",
        properties: {
          range: {
            type: "string",
            enum: ["now", "today", "week", "all"],
            description: "Time window for due-date filtering.",
          },
          maxItems: { type: "number", description: "Max items to return. Default 15." },
          contextToken: { type: "string", description: "Token from hydrate_planning_context (required)." },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

        const tokenValidation = await validatePlanningContextToken(args.contextToken);
        if (!tokenValidation.ok) {
          return formatContent({
            error: tokenValidation.error,
            guardrail: "planning_context_required",
            retryable: true,
          });
        }

        const range = args.range || "today";
        const maxItems = args.maxItems || 15;
        const now = new Date();

        let rangeEnd;
        if (range === "now") rangeEnd = new Date(now.getTime() + 2 * 3600_000);
        else if (range === "today") rangeEnd = new Date(now.toDateString() + " 23:59:59");
        else if (range === "week") rangeEnd = new Date(now.getTime() + 7 * 86400_000);
        else rangeEnd = null;

        try {
          const [tasks, sources, commitments] = await Promise.all([
            readSheetAsObjects("Tasks").catch(() => []),
            readSheetAsObjects("TaskSources").catch(() => []),
            readSheetAsObjects("Commitments").catch(() => []),
          ]);

          const sourceByTaskKey = {};
          sources.forEach((s) => {
            if (!sourceByTaskKey[s.taskKey]) sourceByTaskKey[s.taskKey] = [];
            sourceByTaskKey[s.taskKey].push({ sourceType: s.sourceType, sourceRef: s.sourceRef, excerpt: s.excerpt });
          });

          const scoredTasks = tasks
            .filter((t) => isOpen(t.status))
            .filter((t) => !rangeEnd || !t.dueAt || new Date(t.dueAt) <= rangeEnd)
            .map((t) => {
              const dueDate = t.dueAt ? new Date(t.dueAt) : null;
              const daysUntilDue = dueDate ? daysBetween(now, dueDate) : 999;
              const isOverdue = daysUntilDue < 0;
              let score = 0;
              if (isOverdue) score += 100;
              else if (daysUntilDue === 0) score += 50;
              else if (daysUntilDue <= 1) score += 30;
              else if (daysUntilDue <= 3) score += 20;
              else if (daysUntilDue <= 7) score += 10;
              const priority = String(t.priority || "").toLowerCase();
              if (priority === "high" || priority === "p1") score += 20;
              else if (priority === "medium" || priority === "p2") score += 10;
              return { task: t, score, daysUntilDue, isOverdue };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, maxItems);

          const overdueCommitments = commitments
            .filter((c) => String(c.ownerType) === "me" && isOpen(c.status) && c.dueAt && new Date(c.dueAt) < now)
            .slice(0, 5)
            .map((c) => ({
              type: "commitment",
              commitmentId: c.commitmentId,
              description: c.description,
              dueAt: c.dueAt,
              ownerId: c.ownerId,
              sourceType: c.sourceType,
              sourceRef: c.sourceRef,
              excerpt: c.excerpt,
            }));

          return formatContent({
            range,
            generatedAt: nowIso(),
            contextToken: args.contextToken,
            contextHydratedAt: tokenValidation.context.hydratedAt,
            contextRange: tokenValidation.context.range,
            contextFreshnessMs: tokenValidation.context.expiresAtMs - Date.now(),
            overdueCommitments,
            tasks: scoredTasks.map(({ task, score, daysUntilDue, isOverdue }) => ({
              taskKey: task.taskKey,
              title: task.title || task.subject,
              status: task.status,
              priority: task.priority,
              dueAt: task.dueAt,
              daysUntilDue: daysUntilDue === 999 ? null : daysUntilDue,
              isOverdue,
              score,
              projectId: task.projectId,
              sources: sourceByTaskKey[task.taskKey] || [],
            })),
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── propose_create_task ───────────────────────────────────────────────
    propose_create_task: {
      description:
        "Propose creating a new task. Returns a changesetId + diff preview — does NOT apply yet. " +
        "Call commit_changeset to apply after reviewing. " +
        "REQUIRED: sources array with at least one entry (prevents tasks from being created from memory).",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title." },
          notes: { type: "string" },
          dueAt: { type: "string", description: "ISO date string." },
          priority: { type: "string", enum: ["high", "medium", "low", ""] },
          projectId: { type: "string" },
          ownerId: { type: "string" },
          ownerType: { type: "string", enum: ["me", "other"] },
          origin: { type: "string", enum: ["email", "meeting", "calendar", "intake", "manual", "eod_dump"] },
          sources: {
            type: "array",
            description: "REQUIRED: at least one source entry. Each must have sourceType and sourceRef.",
            items: {
              type: "object",
              properties: {
                sourceType: { type: "string" },
                sourceRef: { type: "string" },
                excerpt: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["sourceType", "sourceRef"],
            },
            minItems: 1,
          },
        },
        required: ["title", "sources"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const { title, notes, dueAt, priority, projectId, ownerId, ownerType, origin, sources } = args;
        if (!sources || sources.length === 0) {
          return formatContent({ error: "sources is required and must have at least one entry." });
        }

        const taskKey = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newTask = {
          taskKey,
          title,
          status: "open",
          notes: notes || "",
          dueAt: dueAt || "",
          priority: priority || "",
          projectId: projectId || "",
          ownerId: ownerId || "",
          ownerType: ownerType || "me",
          origin: origin || "manual",
          confidence: sources[0]?.confidence || 1.0,
          source: sources[0]?.sourceType || "manual",
          updatedAt: nowIso(),
        };

        const taskSourceRows = sources.map((s) => ({
          sourceId: generateId("src"),
          taskKey,
          sourceType: s.sourceType,
          sourceRef: s.sourceRef,
          excerpt: s.excerpt || "",
          confidence: s.confidence !== undefined ? s.confidence : 1.0,
        }));

        const cs = await storeChangeset("tasks", [{ task: newTask, taskSources: taskSourceRows }], [], []);

        return formatContent({
          changesetId: cs.changesetId,
          expiresAt: cs.expiresAt,
          preview: { action: "create_task", task: newTask, sources: taskSourceRows },
          instruction: "Review the preview above. Call commit_changeset({changesetId}) to apply.",
        });
      },
    },

    // ── propose_update_task ───────────────────────────────────────────────
    propose_update_task: {
      description:
        "Propose updating fields on an existing task. Returns a changesetId + before/after diff. " +
        "Does NOT apply yet — call commit_changeset to apply.",
      inputSchema: {
        type: "object",
        properties: {
          taskKey: { type: "string" },
          patch: {
            type: "object",
            description: "Fields to update (status, priority, dueAt, notes, projectId, etc.)",
          },
          sources: {
            type: "array",
            description: "Source(s) justifying this update.",
            items: {
              type: "object",
              properties: {
                sourceType: { type: "string" },
                sourceRef: { type: "string" },
                excerpt: { type: "string" },
              },
              required: ["sourceType", "sourceRef"],
            },
          },
          reason: { type: "string", description: "Why this update is being made." },
        },
        required: ["taskKey", "patch"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const { taskKey, patch, sources, reason } = args;
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

        try {
          const found = await findRowByKey("Tasks", "taskKey", taskKey);
          if (!found) return formatContent({ error: `Task not found: ${taskKey}` });

          const before = { ...found.data };
          const after = { ...before, ...patch, updatedAt: nowIso() };

          const taskSourceRows = (sources || []).map((s) => ({
            sourceId: generateId("src"),
            taskKey,
            sourceType: s.sourceType,
            sourceRef: s.sourceRef,
            excerpt: s.excerpt || "",
            confidence: 1.0,
          }));

          const cs = await storeChangeset("tasks", [], [{ taskKey, before, after, reason: reason || "", newSources: taskSourceRows }], []);

          return formatContent({
            changesetId: cs.changesetId,
            expiresAt: cs.expiresAt,
            preview: { action: "update_task", taskKey, before, after, reason, sources: taskSourceRows },
            instruction: "Review the before/after diff. Call commit_changeset({changesetId}) to apply.",
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── propose_complete_task ─────────────────────────────────────────────
    propose_complete_task: {
      description: "Propose marking a task as done. Returns changeset preview.",
      inputSchema: {
        type: "object",
        properties: {
          taskKey: { type: "string" },
          completionNote: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sourceType: { type: "string" },
                sourceRef: { type: "string" },
                excerpt: { type: "string" },
              },
              required: ["sourceType", "sourceRef"],
            },
          },
        },
        required: ["taskKey"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        return TOOLS.propose_update_task.run({
          taskKey: args.taskKey,
          patch: { status: "done", notes: args.completionNote || "" },
          sources: args.sources || [],
          reason: "Task completed: " + (args.completionNote || ""),
        });
      },
    },

    // ── propose_create_commitment ─────────────────────────────────────────
    propose_create_commitment: {
      description:
        "Propose creating a commitment — something I said I'd do (ownerType=me) or someone else promised (ownerType=other). " +
        "These are tracked separately from tasks and used in the weekly review for accountability.",
      inputSchema: {
        type: "object",
        properties: {
          ownerType: { type: "string", enum: ["me", "other"], description: "Who owns this commitment." },
          ownerId: { type: "string", description: "Email or name of the owner." },
          description: { type: "string" },
          dueAt: { type: "string" },
          sourceType: { type: "string" },
          sourceRef: { type: "string" },
          excerpt: { type: "string", description: "The actual text that established this commitment." },
          projectId: { type: "string" },
          stakeholderId: { type: "string" },
        },
        required: ["ownerType", "description", "sourceType", "sourceRef"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const commitmentId = generateId("cmt");
        const newCommitment = {
          commitmentId,
          ownerType: args.ownerType,
          ownerId: args.ownerId || "",
          description: args.description,
          dueAt: args.dueAt || "",
          status: "open",
          sourceType: args.sourceType,
          sourceRef: args.sourceRef,
          excerpt: args.excerpt || "",
          projectId: args.projectId || "",
          stakeholderId: args.stakeholderId || "",
          lastNudgedAt: "",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        const cs = await storeChangeset("commitments", [newCommitment], [], []);

        return formatContent({
          changesetId: cs.changesetId,
          expiresAt: cs.expiresAt,
          preview: { action: "create_commitment", commitment: newCommitment },
          instruction: "Call commit_changeset({changesetId}) to apply.",
        });
      },
    },

    // ── propose_resolve_commitment ────────────────────────────────────────
    propose_resolve_commitment: {
      description: "Propose marking a commitment as done or dropped.",
      inputSchema: {
        type: "object",
        properties: {
          commitmentId: { type: "string" },
          outcome: { type: "string", enum: ["done", "dropped"] },
          sourceType: { type: "string" },
          sourceRef: { type: "string" },
          excerpt: { type: "string" },
        },
        required: ["commitmentId", "outcome"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

        try {
          const found = await findRowByKey("Commitments", "commitmentId", args.commitmentId);
          if (!found) return formatContent({ error: `Commitment not found: ${args.commitmentId}` });

          const before = { ...found.data };
          const after = { ...before, status: args.outcome, updatedAt: nowIso() };
          const cs = await storeChangeset(
            "commitments",
            [],
            [{ commitmentId: args.commitmentId, before, after, reason: args.outcome }],
            []
          );

          return formatContent({
            changesetId: cs.changesetId,
            expiresAt: cs.expiresAt,
            preview: { action: "resolve_commitment", commitmentId: args.commitmentId, before, after },
            instruction: "Call commit_changeset({changesetId}) to apply.",
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },

    // ── propose_resolve_intake ────────────────────────────────────────────
    propose_resolve_intake: {
      description:
        "Propose resolving (or dropping) a pending intake item. " +
        "An intake item is resolved when you've created a task or commitment from it, or decided it's not actionable.",
      inputSchema: {
        type: "object",
        properties: {
          intakeId: { type: "string" },
          action: { type: "string", enum: ["resolved", "dropped"], description: "resolved = acted on; dropped = not actionable." },
          linkedTaskKey: { type: "string", description: "Optional task created from this intake item." },
          linkedCommitmentId: { type: "string", description: "Optional commitment created from this intake item." },
        },
        required: ["intakeId", "action"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const cs = await storeChangeset("intake", [], [{
          intakeId: args.intakeId,
          newStatus: args.action,
          linkedTaskKey: args.linkedTaskKey || null,
          linkedCommitmentId: args.linkedCommitmentId || null,
        }], []);

        return formatContent({
          changesetId: cs.changesetId,
          expiresAt: cs.expiresAt,
          preview: {
            action: "resolve_intake",
            intakeId: args.intakeId,
            newStatus: args.action,
            linkedTaskKey: args.linkedTaskKey,
            linkedCommitmentId: args.linkedCommitmentId,
          },
          instruction: "Call commit_changeset({changesetId}) to apply.",
        });
      },
    },

    // ── propose_bulk_resolve_intake ───────────────────────────────────────
    // Batch variant of propose_resolve_intake for clearing large backlogs in
    // a single atomic changeset. Accepts many intakeIds + one shared action.
    // Useful when the queue has accumulated a lot of noise (e.g. calendar
    // imports) and the user wants to drop/resolve them all at once without
    // paying the propose→commit round-trip cost per item.
    propose_bulk_resolve_intake: {
      description:
        "Propose resolving or dropping many intake items in one changeset. " +
        "Use this to clear large backlogs (e.g. 'drop every calendar_added older than yesterday'). " +
        "All items get the same action. Returns a single changesetId to commit.",
      inputSchema: {
        type: "object",
        properties: {
          intakeIds: {
            type: "array",
            items: { type: "string" },
            description: "Intake IDs to resolve in this batch.",
          },
          action: {
            type: "string",
            enum: ["resolved", "dropped"],
            description: "resolved = acted on; dropped = not actionable.",
          },
        },
        required: ["intakeIds", "action"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const intakeIds = Array.isArray(args.intakeIds) ? args.intakeIds : [];
        if (intakeIds.length === 0) {
          return formatContent({ error: "propose_bulk_resolve_intake: intakeIds must be a non-empty array" });
        }
        const updates = intakeIds.map((intakeId) => ({
          intakeId,
          newStatus: args.action,
          linkedTaskKey: null,
          linkedCommitmentId: null,
        }));
        const cs = await storeChangeset("intake", [], updates, []);
        return formatContent({
          changesetId: cs.changesetId,
          expiresAt: cs.expiresAt,
          preview: {
            action: "bulk_resolve_intake",
            count: intakeIds.length,
            newStatus: args.action,
          },
          instruction: "Call commit_changeset({changesetId}) to apply.",
        });
      },
    },

    // ── commit_changeset ──────────────────────────────────────────────────
    commit_changeset: {
      description:
        "Apply a proposed changeset returned by any propose_* tool. " +
        "This is the ONLY way to write data — all mutations must go through propose → commit. " +
        "Changesets expire after 10 minutes; if expired, call the propose_* tool again.",
      inputSchema: {
        type: "object",
        properties: {
          changesetId: { type: "string" },
        },
        required: ["changesetId"],
        additionalProperties: false,
      },
      run: async (args = {}) => {
        const { changesetId } = args;
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

        let cs;
        try {
          cs = await getChangeset(changesetId);
        } catch (e) {
          return formatContent({ error: e.message });
        }
        if (!cs) {
          return formatContent({ error: `Changeset not found or expired: ${changesetId}. Call propose_* again.` });
        }

        const results = [];

        try {
          if (cs.kind === "tasks") {
            for (const add of cs.adds || []) {
              const { task, taskSources } = add;
              await appendRows("Tasks", [[
                task.taskKey, task.source || "", task.subject || "", task.title || "",
                task.from || "", task.date || "", task.startTime || "", task.endTime || "",
                task.status || "open", task.priority || "", task.notes || "",
                JSON.stringify(task), task.updatedAt || nowIso(),
                task.ownerType || "me", task.ownerId || "", task.dueAt || "",
                task.projectId || "", String(task.confidence || ""), task.origin || "manual",
              ]]);
              for (const s of taskSources || []) {
                await appendRows("TaskSources", [[
                  s.sourceId, s.taskKey, s.sourceType, s.sourceRef,
                  s.sourceUri || "", s.excerpt || "", String(s.confidence || 1.0), nowIso(),
                ]]);
              }
              results.push({ action: "created_task", taskKey: task.taskKey });
            }

            for (const upd of cs.updates || []) {
              const found = await findRowByKey("Tasks", "taskKey", upd.taskKey);
              if (found) {
                const after = upd.after;
                await updateRow("Tasks", found.rowNum, [
                  after.taskKey, after.source || "", after.subject || "", after.title || "",
                  after.from || "", after.date || "", after.startTime || "", after.endTime || "",
                  after.status || "", after.priority || "", after.notes || "",
                  JSON.stringify(after), nowIso(),
                  after.ownerType || "", after.ownerId || "", after.dueAt || "",
                  after.projectId || "", String(after.confidence || ""), after.origin || "",
                ]);
                for (const s of upd.newSources || []) {
                  await appendRows("TaskSources", [[
                    s.sourceId, s.taskKey, s.sourceType, s.sourceRef,
                    s.sourceUri || "", s.excerpt || "", String(s.confidence || 1.0), nowIso(),
                  ]]);
                }
                results.push({ action: "updated_task", taskKey: upd.taskKey });
              }
            }

          } else if (cs.kind === "commitments") {
            for (const add of cs.adds || []) {
              await appendRows("Commitments", [[
                add.commitmentId, add.ownerType, add.ownerId, add.description,
                add.dueAt, add.status, add.sourceType, add.sourceRef, add.excerpt,
                add.projectId, add.stakeholderId, add.lastNudgedAt, add.createdAt, add.updatedAt,
              ]]);
              results.push({ action: "created_commitment", commitmentId: add.commitmentId });
            }

            for (const upd of cs.updates || []) {
              const found = await findRowByKey("Commitments", "commitmentId", upd.commitmentId);
              if (found) {
                const after = upd.after;
                await updateRow("Commitments", found.rowNum, [
                  after.commitmentId, after.ownerType, after.ownerId, after.description,
                  after.dueAt, after.status, after.sourceType, after.sourceRef, after.excerpt,
                  after.projectId, after.stakeholderId, after.lastNudgedAt, after.createdAt, nowIso(),
                ]);
                results.push({ action: "resolved_commitment", commitmentId: upd.commitmentId });
              }
            }

          } else if (cs.kind === "goals") {
            // Delegate goal row I/O to goals.js so the row layout lives next
            // to the schema. Keep commit_changeset as the single apply path
            // so every write still flows through propose → commit.
            const { commitGoalAdds, commitGoalUpdates } = await import("./goals.js");
            for (const add of cs.adds || []) {
              await commitGoalAdds({ sheets, goals: [add] });
              results.push({ action: "created_goal", goalId: add.goalId });
            }
            for (const upd of cs.updates || []) {
              await commitGoalUpdates({ sheets, updates: [upd] });
              results.push({ action: "updated_goal", goalId: upd.goalId });
            }

          } else if (cs.kind === "projects") {
            const { commitProjectAdds, commitProjectUpdates } = await import("./goals.js");
            for (const add of cs.adds || []) {
              await commitProjectAdds({ sheets, projects: [add] });
              results.push({ action: "created_project", projectId: add.projectId });
            }
            for (const upd of cs.updates || []) {
              await commitProjectUpdates({ sheets, updates: [upd] });
              results.push({ action: "updated_project", projectId: upd.projectId });
            }

          } else if (cs.kind === "intake") {
            for (const upd of cs.updates || []) {
              const found = await findRowByKey("IntakeQueue", "intakeId", upd.intakeId);
              if (found) {
                await updateRow("IntakeQueue", found.rowNum, [
                  upd.intakeId, found.data.kind, found.data.summary, found.data.sourceRef,
                  found.data.payloadJson, upd.newStatus, found.data.createdAt, nowIso(),
                ]);
                results.push({ action: "resolved_intake", intakeId: upd.intakeId, status: upd.newStatus });
              }
            }
          }

          await markChangesetApplied(cs, "claude");

          return formatContent({ ok: true, changesetId, results });
        } catch (e) {
          return formatContent({ error: `commit_changeset failed: ${e.message}`, changesetId });
        }
      },
    },
  };

  // Also expose storeChangeset so sibling tool modules (e.g. goals.js) can
  // propose changesets that flow through the same commit_changeset apply
  // path. Attaching it to the returned registry keeps the factory signature
  // stable for existing consumers that destructure tools by name.
  TOOLS.__storeChangeset = storeChangeset;
  return TOOLS;
}
