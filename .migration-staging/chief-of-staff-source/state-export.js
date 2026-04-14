/**
 * state-export.js — Unified Goals → Projects → Tasks markdown export.
 *
 * Two consumers:
 *   1. MCP tool `export_state_markdown` (agentic): on-demand, returns the
 *      markdown text and optionally writes it to a Drive file.
 *   2. Nightly cron (deterministic): calls `generateStateExport` to produce
 *      and persist `Current_State.md` in the configured Drive folder.
 *
 * Keep the renderer pure (`renderStateMarkdown(state)`) so tests can verify
 * the layout without touching Sheets/Drive.
 */

// ── Pure renderer ────────────────────────────────────────────────────────────

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

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return String(iso); }
}

function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  if (s === "achieved" || s === "done") return "✓";
  if (s === "missed" || s === "dropped") return "✗";
  if (s === "at_risk") return "⚠";
  if (s === "blocked") return "⛔";
  return "·";
}

function nameLookup(stakeholders) {
  const byId = new Map();
  for (const s of stakeholders) {
    if (s.stakeholderId) byId.set(String(s.stakeholderId), s.name || s.email || s.stakeholderId);
  }
  return (id) => byId.get(String(id)) || String(id);
}

/**
 * renderStateMarkdown({ goals, projects, tasks, stakeholders, filter })
 * Returns a string of markdown. Does not touch Sheets/Drive.
 *
 * Layout:
 *   # Current State — <date>
 *   ## Goal: <title> (<quarter>)
 *     ### Project: <name>
 *       - [ ] Task
 *   ## Unassigned Projects (no goalId)
 *   ## Orphan Tasks (no projectId)
 *   ## Stakeholders
 */
export function renderStateMarkdown({ goals = [], projects = [], tasks = [], stakeholders = [], filter = {} } = {}) {
  const now = new Date().toISOString().slice(0, 10);
  const lines = [];
  const nameFor = nameLookup(stakeholders);

  const activeGoals = goals.filter((g) => isOpen(g.status));
  const quarterFilter = filter.quarter ? String(filter.quarter) : null;
  const scopedGoals = quarterFilter
    ? activeGoals.filter((g) => String(g.quarter || "") === quarterFilter)
    : activeGoals;

  lines.push(`# Current State — ${now}`);
  if (quarterFilter) lines.push(`_Quarter: ${quarterFilter}_`);
  lines.push("");
  lines.push(
    `**Totals:** ${scopedGoals.length} active goals · ` +
    `${projects.filter(isOpenWrap).length} active projects · ` +
    `${tasks.filter((t) => isOpen(t.status)).length} open tasks · ` +
    `${stakeholders.length} stakeholders`
  );
  lines.push("");

  // Index projects by goalId and tasks by projectId for O(1) joins.
  const projectsByGoal = new Map();
  for (const p of projects) {
    const gid = String(p.goalId || "");
    if (!projectsByGoal.has(gid)) projectsByGoal.set(gid, []);
    projectsByGoal.get(gid).push(p);
  }
  const tasksByProject = new Map();
  for (const t of tasks) {
    const pid = String(t.projectId || "");
    if (!tasksByProject.has(pid)) tasksByProject.set(pid, []);
    tasksByProject.get(pid).push(t);
  }

  // ── Goals section ────────────────────────────────────────────────────────
  if (scopedGoals.length === 0) {
    lines.push("## Goals");
    lines.push("");
    lines.push("_No active goals. Run the `quarterly-goal-intake` skill to create some._");
    lines.push("");
  }

  for (const goal of scopedGoals) {
    const goalStakeholders = parseJsonArray(goal.stakeholdersJson).map(nameFor);
    lines.push(`## ${statusBadge(goal.status)} Goal: ${goal.title || "(untitled)"} ${goal.quarter ? `(${goal.quarter})` : ""}`);
    if (goal.description) lines.push(`${goal.description}`);
    const goalMeta = [];
    if (goal.priority) goalMeta.push(`priority: ${goal.priority}`);
    if (goal.targetDate) goalMeta.push(`target: ${fmtDate(goal.targetDate)}`);
    if (goalStakeholders.length) goalMeta.push(`stakeholders: ${goalStakeholders.join(", ")}`);
    if (goalMeta.length) lines.push(`_${goalMeta.join(" · ")}_`);
    if (goal.successCriteria) {
      lines.push("");
      lines.push(`**Success criteria:** ${goal.successCriteria}`);
    }
    lines.push("");

    const goalProjects = (projectsByGoal.get(String(goal.goalId || "")) || []).filter(isOpenWrap);
    if (goalProjects.length === 0) {
      lines.push(`_No projects linked to this goal._`);
      lines.push("");
      continue;
    }

    for (const proj of goalProjects) {
      const projStakeholders = parseJsonArray(proj.stakeholdersJson).map(nameFor);
      lines.push(`### ${statusBadge(proj.healthStatus || proj.status)} Project: ${proj.name || proj.projectId}`);
      const projMeta = [];
      if (proj.healthStatus) projMeta.push(`health: ${proj.healthStatus}`);
      if (proj.nextMilestoneAt) projMeta.push(`milestone: ${fmtDate(proj.nextMilestoneAt)}`);
      if (projStakeholders.length) projMeta.push(`stakeholders: ${projStakeholders.join(", ")}`);
      if (projMeta.length) lines.push(`_${projMeta.join(" · ")}_`);
      lines.push("");

      const projTasks = (tasksByProject.get(String(proj.projectId || "")) || []).filter((t) => isOpen(t.status));
      if (projTasks.length === 0) {
        lines.push(`- _(no open tasks)_`);
      } else {
        for (const t of projTasks.slice(0, 20)) {
          const due = t.dueAt ? ` — due ${fmtDate(t.dueAt)}` : "";
          const pri = t.priority ? ` [${t.priority}]` : "";
          lines.push(`- [ ] ${t.title || t.subject || t.taskKey}${pri}${due}`);
        }
        if (projTasks.length > 20) lines.push(`- _…and ${projTasks.length - 20} more_`);
      }
      lines.push("");
    }
  }

  // ── Unassigned projects ──────────────────────────────────────────────────
  const unassignedProjects = projects
    .filter(isOpenWrap)
    .filter((p) => !p.goalId);
  if (unassignedProjects.length > 0) {
    lines.push("## Unassigned Projects (no goalId)");
    lines.push("");
    lines.push("_These projects have no parent goal. Link them during the next quarterly review._");
    lines.push("");
    for (const p of unassignedProjects) {
      lines.push(`- **${p.name || p.projectId}** — ${p.healthStatus || p.status || ""}`);
    }
    lines.push("");
  }

  // ── Orphan tasks ─────────────────────────────────────────────────────────
  const orphanTasks = tasks
    .filter((t) => isOpen(t.status))
    .filter((t) => !t.projectId);
  if (orphanTasks.length > 0) {
    lines.push("## Orphan Tasks (no projectId)");
    lines.push("");
    lines.push(`_${orphanTasks.length} open tasks aren't linked to any project._`);
    lines.push("");
    for (const t of orphanTasks.slice(0, 25)) {
      const due = t.dueAt ? ` — due ${fmtDate(t.dueAt)}` : "";
      lines.push(`- [ ] ${t.title || t.subject || t.taskKey}${due}`);
    }
    if (orphanTasks.length > 25) lines.push(`- _…and ${orphanTasks.length - 25} more_`);
    lines.push("");
  }

  // ── Stakeholders ─────────────────────────────────────────────────────────
  if (stakeholders.length > 0) {
    lines.push("## Stakeholders");
    lines.push("");
    for (const s of stakeholders) {
      const tier = s.tierTag ? ` [${s.tierTag}]` : "";
      lines.push(`- **${s.name || s.email || s.stakeholderId}**${tier}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`_Generated ${new Date().toISOString()}_`);
  return lines.join("\n");
}

function isOpenWrap(p) { return isOpen(p.status); }

// ── Core generator (shared between tool and cron) ───────────────────────────

/**
 * generateStateExport({ sheets, drive, path, filter }) — reads state from
 * Sheets, renders markdown, and (if drive is provided) writes it to a Drive
 * file. Returns { markdown, path, bytesWritten }.
 */
export async function generateStateExport({ sheets, drive, path = "Current_State.md", filter = {} } = {}) {
  const { readSheetAsObjects } = sheets;

  const [goals, projects, tasks, stakeholders] = await Promise.all([
    readSheetAsObjects("Goals").catch(() => []),
    readSheetAsObjects("Projects").catch(() => []),
    readSheetAsObjects("Tasks").catch(() => []),
    readSheetAsObjects("Stakeholders").catch(() => []),
  ]);

  const markdown = renderStateMarkdown({ goals, projects, tasks, stakeholders, filter });

  let bytesWritten = 0;
  if (drive && typeof drive.writeStatusFile === "function") {
    await drive.writeStatusFile({ path, text: markdown });
    bytesWritten = markdown.length;
  }

  return {
    markdown,
    path,
    bytesWritten,
    counts: {
      goals: goals.length,
      projects: projects.length,
      tasks: tasks.length,
      stakeholders: stakeholders.length,
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createStateExportTools({ spreadsheetId, sheets, drive }) {
  function formatContent(obj) {
    return {
      content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
    };
  }

  return {
    export_state_markdown: {
      description:
        "Render the Goals → Projects → Tasks hierarchy (plus orphans and stakeholders) as a single " +
        "markdown document. Returns the markdown inline and, by default, writes it to " +
        "`Current_State.md` in the configured Drive folder so you have a tangible document to browse.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Drive file name. Default: Current_State.md" },
          quarter: { type: "string", description: "Filter goals by quarter (e.g. 2026Q2)." },
          writeToDrive: { type: "boolean", description: "Default true. Set false to return inline only." },
        },
        additionalProperties: false,
      },
      run: async (args = {}) => {
        if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
        try {
          const writeToDrive = args.writeToDrive !== false;
          const path = args.path || "Current_State.md";
          const result = await generateStateExport({
            sheets,
            drive: writeToDrive ? drive : null,
            path,
            filter: args.quarter ? { quarter: args.quarter } : {},
          });
          return formatContent({
            ok: true,
            path: result.path,
            bytesWritten: result.bytesWritten,
            counts: result.counts,
            markdown: result.markdown,
          });
        } catch (e) {
          return formatContent({ error: e.message });
        }
      },
    },
  };
}
