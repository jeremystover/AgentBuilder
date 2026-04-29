/**
 * goals.js — Goals + Projects MCP tools and commit helpers.
 *
 * The hierarchy is:
 *
 *     Goals (quarterly OKRs) → Projects → Tasks
 *
 * Stakeholders link to Goals and Projects via a stakeholdersJson array
 * column (no join table).
 *
 * Factory: createGoalsTools({ spreadsheetId, sheets, storeChangeset }) —
 * returns propose_* tools, get_goal_360, list_goals, list_projects, and
 * backfill_projects_from_tasks. Mutations are two-phase: every propose_*
 * returns a changesetId that commit_changeset (in tools.js) applies.
 *
 * Commit helpers (commitGoalAdds / commitGoalUpdates / commitProjectAdds
 * / commitProjectUpdates) are exported for commit_changeset to delegate
 * row I/O — keeps goal/project row layout next to the schema.
 */

// ── Row layouts ──────────────────────────────────────────────────────────────
// These must match the Goals + Projects column order in bootstrap.js. Any
// schema bump here needs a matching bump in SHEET_SCHEMAS.

const GOAL_COLUMNS = [
  "goalId", "title", "description", "horizon", "quarter",
  "status", "priority", "targetDate", "successCriteria",
  "stakeholdersJson", "notes", "sourceType", "sourceRef",
  "createdAt", "updatedAt",
];

const PROJECT_COLUMNS = [
  "projectId", "name", "goalId", "description", "status", "priority",
  "healthStatus", "nextMilestoneAt", "stakeholdersJson", "notes",
  "sourceType", "sourceRef", "createdAt", "lastTouchedAt", "updatedAt",
];

function nowIso() {
  return new Date().toISOString();
}

function formatContent(obj) {
  return {
    content: [
      { type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) },
    ],
  };
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function isOpen(status) {
  const s = String(status || "").toLowerCase();
  return !s || s === "open" || s === "active" || s === "in_progress" || s === "pending" || s === "todo";
}

function parseJsonArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function rowFromObject(obj, columns) {
  return columns.map((c) => {
    const v = obj[c];
    if (v == null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
}

// ── Commit helpers (called from commit_changeset in tools.js) ───────────────

export async function commitGoalAdds({ sheets, goals }) {
  if (!goals || goals.length === 0) return;
  const rows = goals.map((g) => rowFromObject(g, GOAL_COLUMNS));
  await sheets.appendRows("Goals", rows);
}

export async function commitGoalUpdates({ sheets, updates }) {
  for (const upd of updates || []) {
    const found = await sheets.findRowByKey("Goals", "goalId", upd.goalId);
    if (!found) continue;
    const after = { ...upd.after, updatedAt: nowIso() };
    await sheets.updateRow("Goals", found.rowNum, rowFromObject(after, GOAL_COLUMNS));
  }
}

export async function commitProjectAdds({ sheets, projects }) {
  if (!projects || projects.length === 0) return;
  const rows = projects.map((p) => rowFromObject(p, PROJECT_COLUMNS));
  await sheets.appendRows("Projects", rows);
}

export async function commitProjectUpdates({ sheets, updates }) {
  for (const upd of updates || []) {
    const found = await sheets.findRowByKey("Projects", "projectId", upd.projectId);
    if (!found) continue;
    const after = { ...upd.after, updatedAt: nowIso() };
    await sheets.updateRow("Projects", found.rowNum, rowFromObject(after, PROJECT_COLUMNS));
  }
}

// Soft-delete: marks status='deleted' rather than removing the row, so the
// audit trail stays intact and isOpen() filters the project out of default
// list_projects / get_goal_360 views. Sheets API has no row-delete on the
// values endpoint, and downstream Tasks may still reference the projectId.
export async function commitProjectDeletes({ sheets, deletes }) {
  for (const del of deletes || []) {
    const found = await sheets.findRowByKey("Projects", "projectId", del.projectId);
    if (!found) continue;
    const ts = nowIso();
    const after = { ...found.data, status: "deleted", lastTouchedAt: ts, updatedAt: ts };
    await sheets.updateRow("Projects", found.rowNum, rowFromObject(after, PROJECT_COLUMNS));
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * createGoalsTools({ spreadsheetId, sheets, storeChangeset })
 *
 * storeChangeset is reused from tools.js so every proposal lands in the same
 * Changesets sheet with the same TTL and the same commit_changeset apply
 * path. This keeps the propose → commit invariant intact for goal/project
 * writes.
 */
export function createGoalsTools({ spreadsheetId, sheets, storeChangeset }) {
  const { readSheetAsObjects, findRowByKey } = sheets;

  async function runProposeCreateGoal(args = {}) {
    if (!storeChangeset) return formatContent({ error: "storeChangeset not wired — goals writes disabled" });
    if (!args.title) return formatContent({ error: "title is required" });

    const goalId = args.goalId || generateId("goal");
    const goal = {
      goalId,
      title: args.title,
      description: args.description || "",
      horizon: "quarter",
      quarter: args.quarter || "",
      status: args.status || "active",
      priority: args.priority || "",
      targetDate: args.targetDate || "",
      successCriteria: args.successCriteria || "",
      stakeholdersJson: Array.isArray(args.stakeholderIds) ? JSON.stringify(args.stakeholderIds) : "[]",
      notes: args.notes || "",
      sourceType: args.sourceType || "quarterly_intake",
      sourceRef: args.sourceRef || "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const cs = await storeChangeset("goals", [goal], [], []);
    return formatContent({
      changesetId: cs.changesetId,
      expiresAt: cs.expiresAt,
      preview: { action: "create_goal", goal },
      instruction: "Review the preview. Call commit_changeset({changesetId}) to apply.",
    });
  }

  async function runProposeUpdateGoal(args = {}) {
    if (!storeChangeset) return formatContent({ error: "storeChangeset not wired" });
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    if (!args.goalId) return formatContent({ error: "goalId is required" });

    try {
      const found = await findRowByKey("Goals", "goalId", args.goalId);
      if (!found) return formatContent({ error: `Goal not found: ${args.goalId}` });

      const before = { ...found.data };
      const patch = { ...(args.patch || {}) };
      if (Array.isArray(args.stakeholderIds)) {
        patch.stakeholdersJson = JSON.stringify(args.stakeholderIds);
      }
      const after = { ...before, ...patch };

      const cs = await storeChangeset(
        "goals",
        [],
        [{ goalId: args.goalId, before, after, reason: args.reason || "" }],
        [],
      );
      return formatContent({
        changesetId: cs.changesetId,
        expiresAt: cs.expiresAt,
        preview: { action: "update_goal", goalId: args.goalId, before, after, reason: args.reason },
        instruction: "Call commit_changeset({changesetId}) to apply.",
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  async function runProposeCreateProject(args = {}) {
    if (!storeChangeset) return formatContent({ error: "storeChangeset not wired" });
    if (!args.name) return formatContent({ error: "name is required" });

    const projectId = args.projectId || generateId("proj");
    const project = {
      projectId,
      name: args.name,
      goalId: args.goalId || "",
      description: args.description || "",
      status: args.status || "active",
      priority: args.priority || "",
      healthStatus: args.healthStatus || "on_track",
      nextMilestoneAt: args.nextMilestoneAt || "",
      stakeholdersJson: Array.isArray(args.stakeholderIds) ? JSON.stringify(args.stakeholderIds) : "[]",
      notes: args.notes || "",
      sourceType: args.sourceType || "quarterly_intake",
      sourceRef: args.sourceRef || "",
      createdAt: nowIso(),
      lastTouchedAt: nowIso(),
      updatedAt: nowIso(),
    };

    const cs = await storeChangeset("projects", [project], [], []);
    return formatContent({
      changesetId: cs.changesetId,
      expiresAt: cs.expiresAt,
      preview: { action: "create_project", project },
      instruction: "Call commit_changeset({changesetId}) to apply.",
    });
  }

  async function runProposeUpdateProject(args = {}) {
    if (!storeChangeset) return formatContent({ error: "storeChangeset not wired" });
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    if (!args.projectId) return formatContent({ error: "projectId is required" });

    try {
      const found = await findRowByKey("Projects", "projectId", args.projectId);
      if (!found) return formatContent({ error: `Project not found: ${args.projectId}` });

      const before = { ...found.data };
      const patch = { ...(args.patch || {}) };
      if (Array.isArray(args.stakeholderIds)) {
        patch.stakeholdersJson = JSON.stringify(args.stakeholderIds);
      }
      const after = { ...before, ...patch, lastTouchedAt: nowIso() };

      const cs = await storeChangeset(
        "projects",
        [],
        [{ projectId: args.projectId, before, after, reason: args.reason || "" }],
        [],
      );
      return formatContent({
        changesetId: cs.changesetId,
        expiresAt: cs.expiresAt,
        preview: { action: "update_project", projectId: args.projectId, before, after, reason: args.reason },
        instruction: "Call commit_changeset({changesetId}) to apply.",
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  async function runProposeDeleteProject(args = {}) {
    if (!storeChangeset) return formatContent({ error: "storeChangeset not wired" });
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    if (!args.projectId) return formatContent({ error: "projectId is required" });

    try {
      const found = await findRowByKey("Projects", "projectId", args.projectId);
      if (!found) return formatContent({ error: `Project not found: ${args.projectId}` });

      const before = { ...found.data };
      const cs = await storeChangeset(
        "projects",
        [],
        [],
        [{ projectId: args.projectId, before, reason: args.reason || "" }],
      );
      return formatContent({
        changesetId: cs.changesetId,
        expiresAt: cs.expiresAt,
        preview: { action: "delete_project", projectId: args.projectId, before, reason: args.reason },
        instruction:
          "Soft-delete: marks status='deleted' on commit. Tasks referencing this projectId are left untouched. " +
          "Call commit_changeset({changesetId}) to apply.",
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  async function runListGoals(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    try {
      const goals = await readSheetAsObjects("Goals").catch(() => []);
      const quarter = args.quarter ? String(args.quarter) : null;
      const status = args.status ? String(args.status).toLowerCase() : null;
      const filtered = goals.filter((g) => {
        if (quarter && String(g.quarter) !== quarter) return false;
        if (status && String(g.status || "").toLowerCase() !== status) return false;
        if (!status && !args.includeClosed && !isOpen(g.status)) return false; // default = active only
        return true;
      });
      return formatContent({
        count: filtered.length,
        goals: filtered.map((g) => ({
          goalId: g.goalId,
          title: g.title,
          quarter: g.quarter,
          status: g.status,
          priority: g.priority,
          targetDate: g.targetDate,
          stakeholderIds: parseJsonArray(g.stakeholdersJson),
        })),
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  async function runListProjects(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    try {
      const projects = await readSheetAsObjects("Projects").catch(() => []);
      const goalId = args.goalId ? String(args.goalId) : null;
      const filtered = projects.filter((p) => {
        if (goalId && String(p.goalId) !== goalId) return false;
        if (!isOpen(p.status) && !args.includeClosed) return false;
        return true;
      });
      return formatContent({
        count: filtered.length,
        projects: filtered.map((p) => ({
          projectId: p.projectId,
          name: p.name,
          goalId: p.goalId,
          status: p.status,
          priority: p.priority,
          healthStatus: p.healthStatus,
          nextMilestoneAt: p.nextMilestoneAt,
          stakeholderIds: parseJsonArray(p.stakeholdersJson),
        })),
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  async function runGetGoal360(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    const query = String(args.goalId || "").toLowerCase().trim();
    if (!query) return formatContent({ error: "goalId is required (id or partial title match)" });

    try {
      const [goals, projects, tasks, stakeholders] = await Promise.all([
        readSheetAsObjects("Goals").catch(() => []),
        readSheetAsObjects("Projects").catch(() => []),
        readSheetAsObjects("Tasks").catch(() => []),
        readSheetAsObjects("Stakeholders").catch(() => []),
      ]);

      const goal =
        goals.find((g) => String(g.goalId || "").toLowerCase() === query) ||
        goals.find((g) => String(g.title || "").toLowerCase().includes(query));
      if (!goal) return formatContent({ error: `Goal not found: ${args.goalId}` });

      const goalId = String(goal.goalId || "");
      const childProjects = projects.filter((p) => String(p.goalId || "") === goalId);
      const childProjectIds = new Set(childProjects.map((p) => String(p.projectId || "")));

      const openTasks = tasks
        .filter((t) => childProjectIds.has(String(t.projectId || "")))
        .filter((t) => isOpen(t.status))
        .sort((a, b) => String(a.dueAt || "").localeCompare(String(b.dueAt || "")))
        .slice(0, 30)
        .map((t) => ({
          taskKey: t.taskKey,
          title: t.title || t.subject,
          projectId: t.projectId,
          priority: t.priority,
          dueAt: t.dueAt,
          overdue: !!(t.dueAt && new Date(t.dueAt) < new Date()),
        }));

      // Union of stakeholders on the goal plus every child project.
      const stakeholderIdSet = new Set([
        ...parseJsonArray(goal.stakeholdersJson),
        ...childProjects.flatMap((p) => parseJsonArray(p.stakeholdersJson)),
      ]);
      const linkedStakeholders = stakeholders
        .filter((s) => stakeholderIdSet.has(String(s.stakeholderId || "")))
        .map((s) => ({ stakeholderId: s.stakeholderId, name: s.name, email: s.email, tierTag: s.tierTag }));

      return formatContent({
        goalId,
        title: goal.title,
        description: goal.description,
        quarter: goal.quarter,
        status: goal.status,
        priority: goal.priority,
        targetDate: goal.targetDate,
        successCriteria: goal.successCriteria,
        notes: goal.notes,
        projects: childProjects.map((p) => ({
          projectId: p.projectId,
          name: p.name,
          status: p.status,
          healthStatus: p.healthStatus,
          nextMilestoneAt: p.nextMilestoneAt,
          stakeholderIds: parseJsonArray(p.stakeholdersJson),
        })),
        openTasks,
        stakeholders: linkedStakeholders,
        counts: {
          projects: childProjects.length,
          openTasks: openTasks.length,
          overdueTasks: openTasks.filter((t) => t.overdue).length,
          stakeholders: linkedStakeholders.length,
        },
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  async function runBackfillProjectsFromTasks(args = {}) {
    // Reads every distinct projectId referenced on Tasks, finds which ones
    // are missing from the Projects sheet, and proposes a single changeset
    // that creates stub rows for the missing ones. Safe to dry-run first.
    if (!storeChangeset) return formatContent({ error: "storeChangeset not wired" });
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

    try {
      const [tasks, projects] = await Promise.all([
        readSheetAsObjects("Tasks").catch(() => []),
        readSheetAsObjects("Projects").catch(() => []),
      ]);

      const existingIds = new Set(projects.map((p) => String(p.projectId || "")).filter(Boolean));
      const referencedIds = new Set();
      for (const t of tasks) {
        const pid = String(t.projectId || "").trim();
        if (pid) referencedIds.add(pid);
      }

      const missing = [...referencedIds].filter((pid) => !existingIds.has(pid));
      if (missing.length === 0) {
        return formatContent({
          ok: true,
          referenced: referencedIds.size,
          existing: existingIds.size,
          missing: 0,
          note: "No orphan projectIds on Tasks — Projects sheet is in sync.",
        });
      }

      if (args.dryRun) {
        return formatContent({
          ok: true,
          dryRun: true,
          referenced: referencedIds.size,
          existing: existingIds.size,
          missing: missing.length,
          missingProjectIds: missing,
          note: "Call backfill_projects_from_tasks({dryRun:false}) to propose a changeset.",
        });
      }

      const stubs = missing.map((projectId) => ({
        projectId,
        name: projectId, // stub — rename during the quarterly review
        goalId: "",
        description: "Backfilled from Tasks.projectId — rename and assign a goalId.",
        status: "active",
        priority: "",
        healthStatus: "unknown",
        nextMilestoneAt: "",
        stakeholdersJson: "[]",
        notes: "",
        sourceType: "backfill",
        sourceRef: "tasks_projectId_scan",
        createdAt: nowIso(),
        lastTouchedAt: nowIso(),
        updatedAt: nowIso(),
      }));

      const cs = await storeChangeset("projects", stubs, [], []);
      return formatContent({
        changesetId: cs.changesetId,
        expiresAt: cs.expiresAt,
        preview: {
          action: "backfill_projects",
          count: stubs.length,
          projectIds: missing,
        },
        instruction: "Call commit_changeset({changesetId}) to create the stub rows.",
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  return {
    propose_create_goal: {
      description:
        "Propose creating a new quarterly goal (OKR-style). Returns a changesetId — does NOT apply yet. " +
        "Call commit_changeset to apply. Used by the quarterly-goal-intake skill.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          quarter: { type: "string", description: "e.g. 2026Q2" },
          status: { type: "string", enum: ["active", "achieved", "missed", "dropped"] },
          priority: { type: "string", enum: ["high", "medium", "low", ""] },
          targetDate: { type: "string", description: "ISO date (end of quarter)." },
          successCriteria: { type: "string", description: "How will you know this goal is achieved?" },
          stakeholderIds: {
            type: "array",
            items: { type: "string" },
            description: "Stakeholders accountable for or involved in this goal.",
          },
          notes: { type: "string" },
          sourceType: { type: "string" },
          sourceRef: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      run: runProposeCreateGoal,
    },

    propose_update_goal: {
      description:
        "Propose updating fields on an existing goal (status, priority, successCriteria, stakeholders, etc.). " +
        "Returns a changesetId with before/after diff. Call commit_changeset to apply.",
      inputSchema: {
        type: "object",
        properties: {
          goalId: { type: "string" },
          patch: { type: "object", description: "Fields to update." },
          stakeholderIds: {
            type: "array",
            items: { type: "string" },
            description: "If provided, replaces the stakeholder list entirely.",
          },
          reason: { type: "string" },
        },
        required: ["goalId"],
        additionalProperties: false,
      },
      run: runProposeUpdateGoal,
    },

    propose_create_project: {
      description:
        "Propose creating a new project that ladders up to a goal. Returns a changesetId. " +
        "Tasks reference projects via Tasks.projectId.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          goalId: { type: "string", description: "Parent goal (recommended)." },
          description: { type: "string" },
          status: { type: "string", enum: ["active", "paused", "done", "dropped"] },
          priority: { type: "string", enum: ["high", "medium", "low", ""] },
          healthStatus: { type: "string", enum: ["on_track", "at_risk", "blocked", "unknown"] },
          nextMilestoneAt: { type: "string" },
          stakeholderIds: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
          sourceType: { type: "string" },
          sourceRef: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      run: runProposeCreateProject,
    },

    propose_update_project: {
      description:
        "Propose updating fields on an existing project. Returns changesetId with before/after.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          patch: { type: "object" },
          stakeholderIds: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["projectId"],
        additionalProperties: false,
      },
      run: runProposeUpdateProject,
    },

    propose_delete_project: {
      description:
        "Propose deleting a project. Soft-delete: marks status='deleted' so the row stays in Sheets " +
        "for audit, but it drops out of default list_projects / get_goal_360 results. Tasks that " +
        "reference this projectId are left untouched — clean those up separately if needed. " +
        "Returns a changesetId; call commit_changeset to apply.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["projectId"],
        additionalProperties: false,
      },
      run: runProposeDeleteProject,
    },

    list_goals: {
      description:
        "List goals, optionally filtered by quarter or status. Default returns active goals only.",
      inputSchema: {
        type: "object",
        properties: {
          quarter: { type: "string" },
          status: { type: "string" },
          includeClosed: { type: "boolean" },
        },
        additionalProperties: false,
      },
      run: runListGoals,
    },

    list_projects: {
      description:
        "List projects, optionally filtered by parent goalId. Default returns active projects only.",
      inputSchema: {
        type: "object",
        properties: {
          goalId: { type: "string" },
          includeClosed: { type: "boolean" },
        },
        additionalProperties: false,
      },
      run: runListProjects,
    },

    get_goal_360: {
      description:
        "Return a full 360° view of a goal: parent goal details, child projects, leaf open tasks, " +
        "and linked stakeholders (union of goal + project stakeholders). Use for quarterly check-ins.",
      inputSchema: {
        type: "object",
        properties: {
          goalId: { type: "string", description: "goalId or partial title match." },
        },
        required: ["goalId"],
        additionalProperties: false,
      },
      run: runGetGoal360,
    },

    backfill_projects_from_tasks: {
      description:
        "Scan every distinct projectId on Tasks and propose creating stub rows for any missing in the " +
        "Projects sheet. Run with {dryRun:true} first to see what would be created. Useful after bootstrap " +
        "when Tasks have been created before the Projects sheet existed.",
      inputSchema: {
        type: "object",
        properties: {
          dryRun: { type: "boolean", description: "If true, report what would be created without proposing a changeset." },
        },
        additionalProperties: false,
      },
      run: runBackfillProjectsFromTasks,
    },
  };
}
