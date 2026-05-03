/**
 * web/spa-pages2.js — chief-of-staff page renderers (Projects, People,
 * Triage), per-page modals, and the NAV / ROUTES / AGENT_BRAND wiring
 * that the kit's router consumes.
 *
 * Concatenated after the kit's SPA_CORE_JS and spa-pages.js into
 * /app/app.js.
 */

export const SPA_PAGES2_JS = `
// el, fmtDate, fmtTime, api, toast, openModal, attachVoice are declared
// at top level by spa-core (concatenated above). $$ aliases window.__cos
// for the route() helper used by drag-and-drop / promote callbacks.
const $$ = window.__cos;

// ── Create-task modal (referenced by Today/Week + chat callbacks) ──────────
async function openCreateTaskModal({ projectsById = {}, onChanged, onCreated } = {}) {
  const titleI = el("input", {
    type: "text", placeholder: "Task title…", autofocus: true,
    class: "w-full text-lg font-medium rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none",
  });
  const dueI = el("input", { type: "date", class: "rounded-lg ring-1 ring-slate-200 px-3 py-2" });
  const priI = el("select", { class: "rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white" });
  for (const p of [["", "—"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]) {
    priI.appendChild(el("option", { value: p[0] }, p[1]));
  }
  const projI = el("select", { class: "rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white" });
  projI.appendChild(el("option", { value: "" }, "— No project —"));
  for (const p of Object.values(projectsById)) projI.appendChild(el("option", { value: p.projectId }, p.name));

  const notesI = el("textarea", {
    rows: 3,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: "Notes…",
  });

  const card = el("div", { class: "space-y-4" },
    el("h2", { class: "text-xl font-semibold" }, "New task"),
    titleI,
    el("div", { class: "grid grid-cols-3 gap-3" }, dueI, priI, projI),
    notesI,
    el("div", { class: "flex justify-end" },
      el("button", {
        class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
        onclick: async () => {
          if (!titleI.value.trim()) { toast("Title required", "err"); return; }
          try {
            const res = await api("/api/tasks", { method: "POST", body: {
              title: titleI.value.trim(),
              dueAt: dueI.value ? new Date(dueI.value).toISOString() : "",
              priority: priI.value, projectId: projI.value,
              notes: notesI.value, origin: "manual",
            }});
            modal.close(); toast("Created", "ok");
            if (onCreated) {
              // Pull the newly assigned taskKey out of the propose/commit
              // result so the caller can append a row in place rather than
              // forcing a full page re-render.
              const created = (res?.result?.results || []).find((r) => r.action === "created_task");
              const newTask = {
                taskKey: created?.taskKey || \`tmp_\${Date.now()}\`,
                title: titleI.value.trim(),
                dueAt: dueI.value ? new Date(dueI.value).toISOString() : "",
                priority: priI.value || "",
                projectId: projI.value || "",
                notes: notesI.value || "",
                status: "open",
                today: false,
              };
              onCreated(newTask);
            } else {
              onChanged?.();
            }
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Create"),
    ),
  );
  const modal = openModal(card);
}

// ── Page: Projects (list) ──────────────────────────────────────────────────
// Tabbed shell: "Project View" (goal-grouped project list) and "Task View"
// (cross-project sortable task table). Tab choice is sticky in localStorage.
// Tab change re-renders only the content host so the page header + tab bar
// keep their state — the goal is no full route() refresh on user actions.
function projectsTabFlag() {
  try {
    const v = localStorage.getItem("cos:projectsTab");
    return v === "tasks" ? "tasks" : "projects";
  } catch { return "projects"; }
}
function setProjectsTabFlag(v) {
  try { localStorage.setItem("cos:projectsTab", v); } catch {}
}

function projectsTabBar(active, onChange) {
  const wrap = el("div", { class: "border-b border-slate-200 flex gap-6" });
  const make = (id, label) => {
    const isOn = active === id;
    return el("button", {
      class: isOn
        ? "py-2 -mb-px border-b-2 border-ink text-ink font-medium text-sm"
        : "py-2 -mb-px border-b-2 border-transparent text-slate-500 hover:text-ink text-sm",
      onclick: () => { setProjectsTabFlag(id); onChange(id); },
    }, label);
  };
  wrap.appendChild(make("projects", "Project View"));
  wrap.appendChild(make("tasks", "Task View"));
  return wrap;
}

async function pageProjects(main) {
  let tab = projectsTabFlag();
  main.innerHTML = "";
  const root = el("div", { class: "max-w-5xl mx-auto px-10 py-10 space-y-6" });

  const headerHost = el("header", { class: "flex items-baseline justify-between" });
  const tabBarHost = el("div", {});
  const contentHost = el("div", { class: "space-y-6" });

  async function refreshContent() {
    contentHost.innerHTML = "";
    if (tab === "tasks") await renderProjectsTaskView(contentHost, refreshContent);
    else await renderProjectsProjectView(contentHost, refreshContent);
  }
  function renderHeader() {
    headerHost.innerHTML = "";
    const headerRight = tab === "projects"
      ? el("button", {
          class: "text-sm text-slate-500 hover:text-ink",
          onclick: () => openCreateProjectModal({ onCreated: () => refreshContent() }),
        }, "+ New project")
      : el("button", {
          class: "text-sm text-slate-500 hover:text-ink",
          onclick: async () => {
            const projects = (await api("/api/projects")).projects || [];
            const projectsById = Object.fromEntries(projects.map((p) => [p.projectId, p]));
            openCreateTaskModal({ projectsById, onCreated: () => refreshContent() });
          },
        }, "+ New task");
    headerHost.appendChild(el("h1", { class: "text-3xl font-semibold" }, "Projects"));
    headerHost.appendChild(headerRight);
  }
  function renderTabBar() {
    tabBarHost.innerHTML = "";
    tabBarHost.appendChild(projectsTabBar(tab, async (id) => {
      tab = id;
      renderHeader();
      renderTabBar();
      await refreshContent();
    }));
  }

  renderHeader();
  renderTabBar();
  root.append(headerHost, tabBarHost, contentHost);
  await refreshContent();
  main.appendChild(root);
}

function projectCard(p) {
  const health = (p.healthStatus || "").toLowerCase();
  const dot = health === "off_track" ? "bg-rose-500"
            : health === "at_risk"   ? "bg-amber-500"
            : health === "on_track"  ? "bg-emerald-500"
            : "bg-slate-300";
  return el("a", {
    href: "#/projects/" + encodeURIComponent(p.projectId),
    class: "block bg-white rounded-xl ring-1 ring-slate-200 hover:ring-indigo-300 p-4 transition",
  },
    el("div", { class: "flex items-center gap-3" },
      el("span", { class: "w-2 h-2 rounded-full " + dot }),
      el("div", { class: "flex-1 text-base font-medium text-ink" }, p.name || "(untitled)"),
      el("span", { class: "text-xs text-slate-400" }, p.status || ""),
    ),
    p.nextMilestoneAt ? el("div", { class: "text-xs text-slate-500 mt-1" }, "Next milestone " + fmtDate(p.nextMilestoneAt)) : null,
  );
}

async function renderProjectsProjectView(root) {
  // includeClosed=1 so a project assigned to a since-closed goal still
  // renders under its goal title rather than silently sliding into "No goal".
  const [projData, goalsData] = await Promise.all([
    api("/api/projects"),
    api("/api/goals?includeClosed=1").catch(() => ({ goals: [] })),
  ]);
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "Which projects need attention this week?",
    "Summarize the status of each project",
    "What projects are blocked and why?",
  ]));

  const projects = projData.projects || [];
  if (!projects.length) {
    root.appendChild(el("div", { class: "text-sm text-slate-500" }, "No projects yet."));
    return;
  }

  // Split active from done/inactive so the page leads with what still needs
  // attention. "active" mirrors goals.js isOpen() — empty counts as active
  // for legacy rows.
  const activeStatuses = new Set(["", "open", "active", "in_progress", "pending", "todo"]);
  const activeProjects = [];
  const inactiveProjects = [];
  for (const p of projects) {
    if (activeStatuses.has(String(p.status || "").toLowerCase())) activeProjects.push(p);
    else inactiveProjects.push(p);
  }

  // Group active projects by goalId. Goals render in the order returned by
  // the API (the tool already sorts by quarter/priority); orphans go in a
  // "No goal" bucket at the bottom.
  const goals = goalsData.goals || [];
  const goalOrder = goals.map((g) => g.goalId);
  const goalById = Object.fromEntries(goals.map((g) => [g.goalId, g]));
  const buckets = new Map();
  for (const id of goalOrder) buckets.set(id, []);
  buckets.set("", []); // No-goal bucket — always last
  for (const p of activeProjects) {
    const key = p.goalId && buckets.has(p.goalId) ? p.goalId
              : p.goalId ? p.goalId // unknown/closed goal id we didn't index
              : "";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }

  for (const [goalId, ps] of buckets) {
    if (!ps.length) continue;
    const goal = goalById[goalId];
    const headerText = goal ? (goal.title || "(untitled goal)")
                     : goalId ? "Unknown goal"
                     : "No goal";
    const subText = goal
      ? [goal.quarter, goal.priority].filter(Boolean).join(" · ")
      : "";
    const section = el("section", { class: "space-y-2" });
    section.appendChild(el("div", { class: "flex items-baseline gap-3 mt-2" },
      el("h2", { class: "text-sm uppercase tracking-wide text-slate-500 font-medium" }, headerText),
      subText ? el("span", { class: "text-xs text-slate-400" }, subText) : null,
      el("span", { class: "text-xs text-slate-400" }, ps.length + " project" + (ps.length === 1 ? "" : "s")),
    ));
    const grid = el("div", { class: "grid gap-3" });
    for (const p of ps) grid.appendChild(projectCard(p));
    section.appendChild(grid);
    root.appendChild(section);
  }

  if (inactiveProjects.length) {
    const section = el("section", { class: "space-y-2 pt-6 mt-6 border-t border-slate-200" });
    section.appendChild(el("div", { class: "flex items-baseline gap-3" },
      el("h2", { class: "text-sm uppercase tracking-wide text-slate-500 font-medium" }, "Done & inactive"),
      el("span", { class: "text-xs text-slate-400" }, inactiveProjects.length + " project" + (inactiveProjects.length === 1 ? "" : "s")),
    ));
    const grid = el("div", { class: "grid gap-3 opacity-75" });
    for (const p of inactiveProjects) grid.appendChild(projectCard(p));
    section.appendChild(grid);
    root.appendChild(section);
  }
}

// ── Task View (cross-project sortable table) ───────────────────────────────
function projectsTaskSort() {
  try {
    const raw = localStorage.getItem("cos:projectsTaskSort");
    if (!raw) return { key: "dueAt", dir: "asc" };
    const parsed = JSON.parse(raw);
    return parsed && parsed.key ? parsed : { key: "dueAt", dir: "asc" };
  } catch { return { key: "dueAt", dir: "asc" }; }
}
function setProjectsTaskSort(s) {
  try { localStorage.setItem("cos:projectsTaskSort", JSON.stringify(s)); } catch {}
}

function priorityRank(p) {
  const v = String(p || "").toLowerCase();
  return v === "high" ? 3 : v === "medium" ? 2 : v === "low" ? 1 : 0;
}

function compareTasks(a, b, key) {
  if (key === "title") {
    return String(a.title || "").localeCompare(String(b.title || ""));
  }
  if (key === "projectName") {
    return String(a.projectName || "").localeCompare(String(b.projectName || ""));
  }
  if (key === "priority") {
    return priorityRank(a.priority) - priorityRank(b.priority);
  }
  if (key === "status") {
    return String(a.status || "").localeCompare(String(b.status || ""));
  }
  // dueAt — empty due dates sort last regardless of direction.
  const av = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bv = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

async function renderProjectsTaskView(root, refresh) {
  const includeCompleted = window.showCompletedFlag("projects-tasks");
  const [data, projData] = await Promise.all([
    api("/api/tasks" + (includeCompleted ? "?includeCompleted=1" : "")),
    api("/api/projects"),
  ]);
  const tasks = data.tasks || [];
  const projectsById = Object.fromEntries((projData.projects || []).map((p) => [p.projectId, p]));

  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "What's overdue across all projects?",
    "Which tasks are due this week?",
    "What should I focus on next?",
  ]));

  // Toggle re-renders the table only — caller passes a refresh fn that
  // rebuilds just the content host.
  const controls = el("div", { class: "flex items-center justify-between" },
    el("div", { class: "text-sm text-slate-500" },
      tasks.length + " task" + (tasks.length === 1 ? "" : "s")),
    window.showCompletedToggle("projects-tasks", () => refresh?.()),
  );
  root.appendChild(controls);

  if (!tasks.length) {
    root.appendChild(el("div", { class: "text-sm text-slate-500" }, "No tasks."));
    return;
  }

  const sort = projectsTaskSort();
  const sorted = tasks.slice().sort((a, b) => {
    const cmp = compareTasks(a, b, sort.key);
    return sort.dir === "desc" ? -cmp : cmp;
  });

  const headerCell = (key, label, extra = "") => {
    const isOn = sort.key === key;
    const arrow = isOn ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
    return el("th", {
      class: "text-left text-xs uppercase tracking-wide text-slate-500 font-medium px-3 py-2 cursor-pointer select-none hover:text-ink " + extra,
      onclick: () => {
        const next = isOn ? (sort.dir === "asc" ? "desc" : "asc") : "asc";
        setProjectsTaskSort({ key, dir: next });
        // Re-render only the Task View content rather than the whole page.
        refresh?.();
      },
    }, label + arrow);
  };

  const table = el("table", { class: "w-full bg-white rounded-xl ring-1 ring-slate-200 overflow-hidden" });
  const thead = el("thead", { class: "bg-slate-50 border-b border-slate-200" });
  thead.appendChild(el("tr", {},
    el("th", { class: "px-3 py-2 w-8" }),
    headerCell("title", "Task"),
    headerCell("projectName", "Project"),
    headerCell("priority", "Priority"),
    headerCell("dueAt", "Due"),
    headerCell("status", "Status"),
    el("th", { class: "px-3 py-2 w-8" }),
  ));
  table.appendChild(thead);

  const tbody = el("tbody", {});
  for (const t of sorted) {
    const pri = (t.priority || "").toLowerCase();
    const priClass = pri === "high" ? "bg-rose-100 text-rose-700"
                   : pri === "medium" ? "bg-amber-100 text-amber-800"
                   : pri === "low" ? "bg-slate-100 text-slate-600"
                   : "text-slate-400";
    const due = t.dueAt ? fmtDate(t.dueAt) : "";
    const overdue = isOverdue(t.dueAt);
    const dueClass = overdue ? "text-rose-600 font-medium" : "text-slate-600";
    const statusLabel = String(t.status || "open");
    const statusClass = statusLabel.toLowerCase() === "done" ? "text-emerald-600" : "text-slate-600";
    const isDone = statusLabel.toLowerCase() === "done";

    const tr = el("tr", {
      class: "border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer",
      onclick: () => window.openTaskEditor(t, {
        // Update the row in place after a save instead of re-rendering;
        // remove it on completion.
        // Cell indices: 0=complete, 1=title, 2=project, 3=priority, 4=due, 5=status, 6=delete.
        onSaved: (patch) => {
          Object.assign(t, patch);
          tr.cells[1].textContent = t.title || "(untitled)";
          const newDue = t.dueAt ? fmtDate(t.dueAt) : "—";
          tr.cells[4].textContent = newDue;
          tr.cells[4].className = "px-3 py-2 text-sm " + (isOverdue(t.dueAt) ? "text-rose-600 font-medium" : "text-slate-600");
          // Priority cell: easiest to swap by recomputing.
          const np = (t.priority || "").toLowerCase();
          const npClass = np === "high" ? "bg-rose-100 text-rose-700"
                        : np === "medium" ? "bg-amber-100 text-amber-800"
                        : np === "low" ? "bg-slate-100 text-slate-600"
                        : "text-slate-400";
          tr.cells[3].innerHTML = "";
          tr.cells[3].appendChild(np
            ? el("span", { class: "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded " + npClass }, np)
            : el("span", { class: "text-xs text-slate-400" }, "—"));
          // If a future editor lets the user change project, keep the
          // inline select in sync.
          if (Object.prototype.hasOwnProperty.call(patch, "projectId")) {
            const p = patch.projectId && projectsById[patch.projectId];
            t.projectName = p ? (p.name || "") : "";
            projSel.value = patch.projectId || "";
          }
        },
        onCompleted: animateOut,
      }),
    });

    function animateOut() {
      tr.style.transition = "opacity 200ms ease";
      tr.style.pointerEvents = "none";
      tr.style.opacity = "0";
      setTimeout(() => tr.remove(), 220);
    }

    // Complete checkbox — fire-and-forget; animate row out on success.
    const completeBtn = el("button", {
      class: isDone
        ? "shrink-0 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center"
        : "shrink-0 w-5 h-5 rounded-full border-2 border-slate-300 hover:border-emerald-500 transition flex items-center justify-center",
      title: isDone ? "Already complete" : "Mark complete",
      onclick: async (e) => {
        e.stopPropagation();
        if (isDone) return;
        tr.style.transition = "opacity 200ms ease";
        tr.style.opacity = "0.4";
        tr.style.pointerEvents = "none";
        try {
          await api(\`/api/tasks/\${encodeURIComponent(t.taskKey)}/complete\`, { method: "POST", body: {} });
          toast("Completed", "ok");
          animateOut();
        } catch (err) {
          tr.style.opacity = "";
          tr.style.pointerEvents = "";
          toast(err.message, "err");
        }
      },
    }, isDone ? "✓" : "");

    // Inline project select — change to reassign without leaving the page.
    const projSel = el("select", {
      class: "rounded ring-1 ring-transparent hover:ring-slate-200 bg-transparent text-sm text-slate-600 hover:text-ink px-1 py-0.5 cursor-pointer focus:ring-indigo-300 focus:outline-none max-w-[12rem]",
      onclick: (e) => e.stopPropagation(),
      onchange: async (e) => {
        e.stopPropagation();
        const newProj = e.target.value;
        const prevProj = t.projectId || "";
        if (newProj === prevProj) return;
        const prevName = t.projectName || "";
        t.projectId = newProj;
        t.projectName = newProj && projectsById[newProj] ? (projectsById[newProj].name || "") : "";
        try {
          await api(\`/api/tasks/\${encodeURIComponent(t.taskKey)}\`, {
            method: "PATCH", body: { patch: { projectId: newProj } },
          });
          toast(newProj ? "Moved to " + (t.projectName || "project") : "Project cleared", "ok");
        } catch (err) {
          t.projectId = prevProj;
          t.projectName = prevName;
          projSel.value = prevProj;
          toast(err.message, "err");
        }
      },
    });
    projSel.appendChild(el("option", { value: "" }, "— No project —"));
    for (const p of Object.values(projectsById)) {
      const o = el("option", { value: p.projectId }, p.name || "(untitled)");
      if ((t.projectId || "") === p.projectId) o.selected = true;
      projSel.appendChild(o);
    }
    // Surface unknown project ids (e.g. closed/deleted) so the select still
    // reflects the task's current value rather than silently snapping to "—".
    if (t.projectId && !projectsById[t.projectId]) {
      const o = el("option", { value: t.projectId }, t.projectName || t.projectId);
      o.selected = true;
      projSel.appendChild(o);
    }

    // Delete (soft-delete via status='deleted') — drops the row from the
    // default view since 'deleted' isn't an open status.
    const deleteBtn = el("button", {
      class: "shrink-0 w-5 h-5 rounded text-slate-300 hover:text-rose-600 hover:bg-rose-50 transition flex items-center justify-center text-sm leading-none",
      title: "Delete task",
      onclick: async (e) => {
        e.stopPropagation();
        tr.style.transition = "opacity 200ms ease";
        tr.style.opacity = "0.4";
        tr.style.pointerEvents = "none";
        try {
          await api(\`/api/tasks/\${encodeURIComponent(t.taskKey)}\`, {
            method: "PATCH", body: { patch: { status: "deleted" }, reason: "deleted via web UI" },
          });
          toast("Deleted", "ok");
          animateOut();
        } catch (err) {
          tr.style.opacity = "";
          tr.style.pointerEvents = "";
          toast(err.message, "err");
        }
      },
    }, "✕");

    tr.appendChild(el("td", { class: "px-3 py-2 align-middle" }, completeBtn));
    tr.appendChild(el("td", { class: "px-3 py-2 text-sm text-ink" }, t.title || "(untitled)"));
    tr.appendChild(el("td", { class: "px-3 py-2 text-sm" }, projSel));
    tr.appendChild(el("td", { class: "px-3 py-2" },
      pri
        ? el("span", { class: "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded " + priClass }, pri)
        : el("span", { class: "text-xs text-slate-400" }, "—"),
    ));
    tr.appendChild(el("td", { class: "px-3 py-2 text-sm " + dueClass }, due || "—"));
    tr.appendChild(el("td", { class: "px-3 py-2 text-sm " + statusClass }, statusLabel));
    tr.appendChild(el("td", { class: "px-3 py-2 align-middle text-right" }, deleteBtn));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(el("div", { class: "overflow-x-auto" }, table));
}

function openCreateProjectModal({ onChanged, onCreated } = {}) {
  const nameI = el("input", { type: "text", placeholder: "Project name", autofocus: true,
    class: "w-full text-lg font-medium rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none" });
  const descI = el("textarea", { rows: 3, placeholder: "Description…",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none" });
  const card = el("div", { class: "space-y-4" },
    el("h2", { class: "text-xl font-semibold" }, "New project"),
    nameI, descI,
    el("div", { class: "flex justify-end" },
      el("button", {
        class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
        onclick: async () => {
          if (!nameI.value.trim()) { toast("Name required", "err"); return; }
          try {
            const r = await api("/api/projects", { method: "POST", body: { name: nameI.value.trim(), description: descI.value } });
            modal.close(); toast("Created", "ok");
            if (onCreated) {
              const created = (r?.result?.results || []).find((x) => x.action === "created_project");
              onCreated({
                projectId: created?.projectId || \`tmp_\${Date.now()}\`,
                name: nameI.value.trim(),
                status: "",
                healthStatus: "",
              });
            } else {
              onChanged?.();
            }
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Create"),
    ),
  );
  const modal = openModal(card);
}

// ── Page: Project detail (360 view) ────────────────────────────────────────
async function pageProjectDetail(main, projectId) {
  const [data, peopleData] = await Promise.all([
    api("/api/projects/" + encodeURIComponent(projectId)),
    api("/api/people"),
  ]);
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-8" });
  root.appendChild(el("a", { href: "#/projects", class: "text-xs text-slate-500 hover:text-ink" }, "← Projects"));
  const isDone = String(data.status || "").toLowerCase() === "done";
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, data.name || "(untitled project)"),
    el("div", { class: "flex items-baseline gap-4" },
      el("span", { class: "text-sm text-slate-500" }, (data.status || "") + (data.healthStatus ? " · " + data.healthStatus : "")),
      el("button", {
        class: isDone
          ? "text-sm text-emerald-600 hover:text-emerald-800"
          : "text-sm text-slate-500 hover:text-emerald-700",
        onclick: async () => {
          try {
            const newStatus = isDone ? "active" : "done";
            await api("/api/projects/" + encodeURIComponent(projectId), {
              method: "PATCH",
              body: { patch: { status: newStatus }, reason: "marked " + newStatus + " via web UI" },
            });
            toast(isDone ? "Project reopened" : "Project marked done", "ok");
            window.location.hash = "#/projects";
          } catch (err) { toast(err.message, "err"); }
        },
      }, isDone ? "Reopen project" : "Mark done"),
    ),
  ));
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "What's the latest on this project?",
    "What are the risks?",
    "Draft a status update",
  ]));

  // Stakeholders
  const stakeholdersSec = el("section", { class: "space-y-3" });
  const stakeholderRow = el("div", { class: "flex flex-wrap gap-2" });
  let stakeholdersEmpty = null;
  function stakeholderPill(sh) {
    const id = sh.stakeholderId || sh.id || sh.email || sh.name || "";
    const label = sh.name || sh.email || sh.stakeholderId || "(unnamed)";
    const sub = sh.email && sh.name ? sh.email : "";
    return el("a", {
      href: "#/people/" + encodeURIComponent(id),
      class: "px-3 py-1.5 bg-white rounded-full ring-1 ring-slate-200 text-sm hover:ring-indigo-300 inline-flex items-baseline gap-2",
      title: sub || label,
    },
      el("span", { class: "text-ink" }, label),
      sub ? el("span", { class: "text-xs text-slate-400" }, sub) : null,
    );
  }
  function appendStakeholder(sh) {
    if (stakeholdersEmpty && stakeholdersEmpty.parentNode) {
      stakeholdersEmpty.remove();
      stakeholdersEmpty = null;
    }
    stakeholderRow.appendChild(stakeholderPill(sh));
  }
  stakeholdersSec.appendChild(el("div", { class: "flex items-baseline justify-between" },
    el("h2", { class: "text-lg font-semibold" }, "Stakeholders"),
    el("button", { class: "text-xs text-slate-500 hover:text-ink",
      onclick: () => openAddStakeholderToProjectModal(projectId, peopleData.people || [], appendStakeholder) },
      "+ Add stakeholder"),
  ));
  for (const sh of data.stakeholders || []) stakeholderRow.appendChild(stakeholderPill(sh));
  if (!data.stakeholders?.length) {
    stakeholdersEmpty = el("div", { class: "text-sm text-slate-500" }, "None yet.");
    stakeholderRow.appendChild(stakeholdersEmpty);
  }
  stakeholdersSec.appendChild(stakeholderRow);
  root.appendChild(stakeholdersSec);

  // Tasks (with show-completed toggle scoped to this project)
  const tasksSec = el("section", { class: "space-y-1" });
  const projectProjectsById = { [projectId]: { projectId, name: data.name } };
  const openListHost = el("div", { class: "space-y-1" });
  const completedListHost = el("div", { class: "space-y-1" });
  let emptyOpenTasksEl = null;

  function renderOpen(tasks) {
    openListHost.innerHTML = "";
    if (!tasks?.length) {
      emptyOpenTasksEl = el("div", { class: "text-sm text-slate-500" }, "No open tasks.");
      openListHost.appendChild(emptyOpenTasksEl);
      return;
    }
    emptyOpenTasksEl = null;
    for (const t of tasks) openListHost.appendChild(window.taskRow(t, { showProject: false, projectsById: projectProjectsById }));
  }
  function renderCompleted(tasks) {
    completedListHost.innerHTML = "";
    if (!tasks?.length) return;
    completedListHost.appendChild(el("h3", { class: "text-xs uppercase tracking-wide text-slate-400 mt-4" }, "Completed"));
    for (const t of tasks) completedListHost.appendChild(window.taskRow(t, { showProject: false, projectsById: projectProjectsById }));
  }
  function appendCreatedProjectTask(newTask) {
    if (emptyOpenTasksEl && emptyOpenTasksEl.parentNode) {
      emptyOpenTasksEl.remove();
      emptyOpenTasksEl = null;
    }
    openListHost.appendChild(window.taskRow(newTask, { showProject: false, projectsById: projectProjectsById }));
  }
  async function refreshProjectTasks() {
    try {
      const fresh = await api("/api/projects/" + encodeURIComponent(projectId));
      renderOpen(fresh.openTasks || []);
      const showDoneNow = window.showCompletedFlag("project:" + projectId);
      if (showDoneNow) {
        try {
          const done = await api("/api/tasks/completed?scope=all&projectId=" + encodeURIComponent(projectId));
          renderCompleted(done.tasks || []);
        } catch (err) { /* surface elsewhere */ }
      } else {
        renderCompleted([]);
      }
    } catch (err) { toast(err.message, "err"); }
  }

  tasksSec.appendChild(el("div", { class: "flex items-baseline justify-between mb-2 gap-3" },
    el("h2", { class: "text-lg font-semibold" }, "Open tasks"),
    el("div", { class: "flex items-center gap-2" },
      window.showCompletedToggle("project:" + projectId, refreshProjectTasks),
      el("button", { class: "text-xs text-slate-500 hover:text-ink",
        onclick: () => openCreateTaskModal({ projectsById: projectProjectsById, onCreated: appendCreatedProjectTask }) },
        "+ Add task"),
    ),
  ));
  tasksSec.appendChild(openListHost);
  tasksSec.appendChild(completedListHost);
  renderOpen(data.openTasks || []);
  if (window.showCompletedFlag("project:" + projectId)) {
    try {
      const done = await api("/api/tasks/completed?scope=all&projectId=" + encodeURIComponent(projectId));
      renderCompleted(done.tasks || []);
    } catch (err) { /* surfaced elsewhere */ }
  }
  root.appendChild(tasksSec);

  // Meetings — upcoming, then recent. Reuses the rich meetingCard from
  // spa-pages.js so day-of-week, calendar invite, and Zoom links render
  // the same everywhere.
  const upcomingHost = el("div", { class: "space-y-3" });
  const recentHost = el("div", { class: "space-y-3" });
  if (data.upcomingMeetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Upcoming meetings"));
    sec.appendChild(upcomingHost);
    for (const m of data.upcomingMeetings) upcomingHost.appendChild(window.meetingCard(m));
    root.appendChild(sec);
  }
  if (data.recentMeetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Recent meetings"));
    sec.appendChild(recentHost);
    for (const m of data.recentMeetings) recentHost.appendChild(window.meetingCard(m));
    root.appendChild(sec);
  }
  const meetingActions = el("div", { class: "flex gap-4" },
    el("button", {
      class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openCreateMeetingModal({ projectName: data.name, stakeholders: data.stakeholders || [] }),
    }, "+ Schedule meeting"),
    el("button", {
      class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openLinkMeetingModal(projectId, (linkedMeeting) => {
        if (linkedMeeting) upcomingHost.appendChild(window.meetingCard(linkedMeeting));
      }),
    }, "+ Link existing meeting"),
  );
  root.appendChild(meetingActions);

  // Notes (project-scoped)
  try {
    const notesData = await api(\`/api/notes?entityType=project&entityId=\${encodeURIComponent(projectId)}\`);
    root.appendChild(notesSection({
      entityType: "project", entityId: projectId, initialNotes: notesData.notes || [],
    }));
  } catch (err) { /* surface elsewhere */ }

  main.appendChild(root);
}

function openAddStakeholderToProjectModal(projectId, allPeople, onAdded) {
  const sel = el("select", { class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white" });
  sel.appendChild(el("option", { value: "" }, "— Pick existing —"));
  for (const p of allPeople) sel.appendChild(el("option", { value: p.stakeholderId }, p.name || p.email));
  const newName = el("input", { type: "text", placeholder: "Or new name", class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2" });
  const newEmail = el("input", { type: "email", placeholder: "New email", class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2" });
  const peopleById = Object.fromEntries(allPeople.map((p) => [p.stakeholderId, p]));
  const card = el("div", { class: "space-y-4" },
    el("h2", { class: "text-xl font-semibold" }, "Add stakeholder"),
    sel,
    el("div", { class: "text-xs text-slate-400 text-center" }, "or"),
    newName, newEmail,
    el("div", { class: "flex justify-end" },
      el("button", {
        class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
        onclick: async () => {
          try {
            let id = sel.value;
            let added = id ? peopleById[id] : null;
            if (!id && (newName.value || newEmail.value)) {
              const r = await api("/api/people", { method: "POST", body: { name: newName.value, email: newEmail.value } });
              id = r.stakeholderId;
              added = { stakeholderId: id, name: newName.value, email: newEmail.value };
            }
            if (!id) { toast("Pick or create a person", "err"); return; }
            const cur = await api("/api/projects/" + encodeURIComponent(projectId));
            const ids = new Set([...(cur.stakeholders || []).map((s) => s.stakeholderId), id].filter(Boolean));
            await api("/api/projects/" + encodeURIComponent(projectId), {
              method: "PATCH", body: { patch: {}, stakeholderIds: [...ids] }
            });
            modal.close(); toast("Added", "ok");
            if (added) onAdded?.(added);
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Add"),
    ),
  );
  const modal = openModal(card);
}

function openCreateMeetingModal({ projectName, stakeholders }) {
  const titleI = el("input", { type: "text", value: projectName ? "Meeting — " + projectName : "",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-base font-medium" });
  const startI = el("input", { type: "datetime-local", class: "rounded-lg ring-1 ring-slate-200 px-3 py-2" });
  const endI   = el("input", { type: "datetime-local", class: "rounded-lg ring-1 ring-slate-200 px-3 py-2" });
  const desc = el("textarea", { rows: 3, placeholder: "Agenda…",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none" });
  const emails = stakeholders.map((s) => s.email).filter(Boolean);
  const card = el("div", { class: "space-y-4" },
    el("h2", { class: "text-xl font-semibold" }, "Schedule meeting"),
    titleI,
    el("div", { class: "grid grid-cols-2 gap-3" }, startI, endI),
    desc,
    el("div", { class: "text-xs text-slate-500" },
      emails.length ? "Attendees: " + emails.join(", ") : "No stakeholder emails on file."),
    el("div", { class: "flex justify-end" },
      el("button", {
        class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
        onclick: async () => {
          if (!startI.value || !endI.value) { toast("Pick a start and end", "err"); return; }
          try {
            await api("/api/calendar", { method: "POST", body: {
              title: titleI.value,
              startTime: new Date(startI.value).toISOString(),
              endTime: new Date(endI.value).toISOString(),
              description: desc.value, attendeeEmails: emails,
            }});
            modal.close(); toast("Scheduled", "ok");
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Schedule"),
    ),
  );
  const modal = openModal(card);
}

async function openLinkMeetingModal(projectId, onDone) {
  // Pull the next 14 days of meetings — wide enough to cover "this week"
  // and a bit of next week so a Friday-afternoon planning session can grab
  // an early-Monday meeting.
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 14);
  let meetings = [];
  try {
    const r = await api(\`/api/calendar?from=\${encodeURIComponent(from.toISOString())}&to=\${encodeURIComponent(to.toISOString())}\`);
    meetings = r.meetings || [];
  } catch (err) { toast(err.message, "err"); return; }
  if (!meetings.length) {
    toast("No upcoming meetings to link", "info");
    return;
  }
  const sel = el("select", { class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white" });
  sel.appendChild(el("option", { value: "" }, "— Pick a meeting —"));
  for (const m of meetings) {
    const day = new Date(m.startTime).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const time = fmtTime(m.startTime);
    sel.appendChild(el("option", { value: m.meetingId || m.eventId }, \`\${day} \${time} — \${m.title || "(untitled)"}\`));
  }
  const card = el("div", { class: "space-y-3" },
    el("h2", { class: "text-base font-semibold" }, "Link existing meeting"),
    sel,
    el("div", { class: "flex justify-end gap-2" },
      el("button", { class: "px-3 py-1.5 text-sm rounded-lg ring-1 ring-slate-200",
        onclick: () => modal.close() }, "Cancel"),
      el("button", { class: "px-3 py-1.5 text-sm rounded-lg bg-ink text-white",
        onclick: async () => {
          if (!sel.value) { toast("Pick a meeting", "err"); return; }
          try {
            await api(\`/api/meetings/\${encodeURIComponent(sel.value)}/link-project\`, {
              method: "POST", body: { projectId },
            });
            modal.close(); toast("Linked", "ok");
            const linked = meetings.find((m) => (m.meetingId || m.eventId) === sel.value);
            onDone?.(linked || null);
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Link"),
    ),
  );
  const modal = openModal(card);
}

// ── Page: People (list) ────────────────────────────────────────────────────
function personListCard(p) {
  return el("a", {
    href: "#/people/" + encodeURIComponent(p.stakeholderId),
    class: "block bg-white rounded-xl ring-1 ring-slate-200 hover:ring-indigo-300 p-3 px-4 transition",
  },
    el("div", { class: "flex items-center justify-between gap-3" },
      el("div", {},
        el("div", { class: "text-sm font-medium" }, p.name || p.email),
        p.email && p.name ? el("div", { class: "text-xs text-slate-500" }, p.email) : null,
      ),
      p.tierTag ? el("span", { class: "text-xs text-slate-500" }, p.tierTag) : null,
    ),
  );
}

async function pagePeople(main) {
  const data = await api("/api/people");
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-6" });
  const list = el("div", { class: "grid gap-2" });
  let emptyEl = null;
  function appendCreatedPerson(p) {
    if (emptyEl && emptyEl.parentNode) { emptyEl.remove(); emptyEl = null; }
    list.insertBefore(personListCard(p), list.firstChild);
  }
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, "People"),
    el("button", { class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openCreatePersonModal({ onCreated: appendCreatedPerson }) }, "+ New person"),
  ));
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "Who haven't I touched in a while?",
    "Top 5 stakeholders to check in with",
    "Draft a 1:1 prep for my next meeting",
  ]));
  if (!data.people?.length) {
    emptyEl = el("div", { class: "text-sm text-slate-500" }, "No stakeholders yet.");
    root.appendChild(emptyEl);
  }
  for (const p of data.people || []) list.appendChild(personListCard(p));
  root.appendChild(list);
  main.appendChild(root);
}

function openCreatePersonModal({ onDone, onCreated } = {}) {
  const nameI = el("input", { type: "text", placeholder: "Name", autofocus: true,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-base font-medium" });
  const emailI = el("input", { type: "email", placeholder: "Email",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2" });
  const tierI = el("input", { type: "text", placeholder: "Tier (optional)",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2" });
  const card = el("div", { class: "space-y-3" },
    el("h2", { class: "text-xl font-semibold" }, "New person"),
    nameI, emailI, tierI,
    el("div", { class: "flex justify-end" },
      el("button", {
        class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
        onclick: async () => {
          if (!nameI.value && !emailI.value) { toast("Name or email required", "err"); return; }
          try {
            const r = await api("/api/people", { method: "POST", body: { name: nameI.value, email: emailI.value, tierTag: tierI.value } });
            modal.close(); toast("Added", "ok");
            if (onCreated) {
              onCreated({
                stakeholderId: r.stakeholderId,
                name: nameI.value,
                email: emailI.value,
                tierTag: tierI.value,
              });
            } else {
              onDone?.();
            }
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Add"),
    ),
  );
  const modal = openModal(card);
}

async function pagePersonDetail(main, personId) {
  const [data, briefData, notesData, allProjects] = await Promise.all([
    api("/api/people/" + encodeURIComponent(personId)),
    api(\`/api/people/\${encodeURIComponent(personId)}/brief\`).catch(() => ({ brief: { goalsMd: "" } })),
    api(\`/api/notes?entityType=person&entityId=\${encodeURIComponent(personId)}\`).catch(() => ({ notes: [] })),
    api("/api/projects").catch(() => ({ projects: [] })),
  ]);
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-8" });
  root.appendChild(el("a", { href: "#/people", class: "text-xs text-slate-500 hover:text-ink" }, "← People"));
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, data.name || data.email || personId),
    el("span", { class: "text-sm text-slate-500" }, data.tierTag || ""),
  ));
  if (data.email) root.appendChild(el("div", { class: "text-sm text-slate-500" }, data.email));
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "What should I bring up next time we meet?",
    "What are my open commitments to them?",
    "Draft a check-in message",
  ]));

  // Person brief — editable goals box + ✨ AI generate.
  root.appendChild(personBriefEditor(personId, briefData.brief || { goalsMd: "" }));

  // Open tasks
  if (data.openTasks?.length) {
    const sec = el("section", { class: "space-y-1" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Open tasks"));
    for (const t of data.openTasks) sec.appendChild(window.taskRow(t));
    root.appendChild(sec);
  }

  // Projects (linked) + actions
  {
    const sec = el("section", { class: "space-y-2" });
    const projectsHost = el("div", { class: "space-y-2" });
    let emptyProjectsEl = null;
    const linkedProjectIds = new Set((data.projects || []).map((p) => p.projectId));
    function projectLinkCard(p) {
      return el("a", {
        href: "#/projects/" + encodeURIComponent(p.projectId),
        class: "block bg-white rounded-xl ring-1 ring-slate-200 hover:ring-indigo-300 p-3 px-4 text-sm",
      }, p.name);
    }
    function appendLinkedProject(p) {
      if (linkedProjectIds.has(p.projectId)) return;
      linkedProjectIds.add(p.projectId);
      if (emptyProjectsEl && emptyProjectsEl.parentNode) {
        emptyProjectsEl.remove();
        emptyProjectsEl = null;
      }
      projectsHost.appendChild(projectLinkCard(p));
    }
    sec.appendChild(el("div", { class: "flex items-baseline justify-between" },
      el("h2", { class: "text-lg font-semibold" }, "Projects"),
      el("div", { class: "flex gap-3 text-xs" },
        el("button", { class: "text-slate-500 hover:text-ink",
          onclick: () => openLinkProjectToPersonModal(personId, allProjects.projects || [], appendLinkedProject),
        }, "+ Link existing"),
        el("button", { class: "text-slate-500 hover:text-ink",
          onclick: () => openCreateProjectThenLinkModal(personId, appendLinkedProject),
        }, "+ New project"),
      ),
    ));
    if (!data.projects?.length) {
      emptyProjectsEl = el("div", { class: "text-sm text-slate-500" }, "No projects linked.");
      projectsHost.appendChild(emptyProjectsEl);
    }
    for (const p of data.projects || []) projectsHost.appendChild(projectLinkCard(p));
    sec.appendChild(projectsHost);
    root.appendChild(sec);
  }

  // Upcoming meetings
  const upcomingMeetingsHost = el("div", { class: "space-y-3" });
  let upcomingEmptyEl = null;
  function appendInvitedMeeting(m) {
    if (upcomingEmptyEl && upcomingEmptyEl.parentNode) {
      upcomingEmptyEl.remove();
      upcomingEmptyEl = null;
    }
    upcomingMeetingsHost.appendChild(window.meetingCard(m));
  }
  {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("div", { class: "flex items-baseline justify-between" },
      el("h2", { class: "text-lg font-semibold" }, "Upcoming meetings"),
      el("div", { class: "flex gap-3 text-xs" },
        el("button", { class: "text-slate-500 hover:text-ink",
          onclick: () => openInvitePersonToMeetingModal(personId, data.email, appendInvitedMeeting),
        }, "+ Invite to existing"),
        el("button", { class: "text-slate-500 hover:text-ink",
          onclick: () => openCreateMeetingModal({ projectName: "", stakeholders: data.email ? [{ email: data.email, name: data.name }] : [] }),
        }, "+ Schedule new"),
      ),
    ));
    if (!data.upcomingMeetings?.length) {
      upcomingEmptyEl = el("div", { class: "text-sm text-slate-500" }, "Nothing on the calendar.");
      sec.appendChild(upcomingEmptyEl);
    }
    sec.appendChild(upcomingMeetingsHost);
    for (const m of data.upcomingMeetings || []) upcomingMeetingsHost.appendChild(window.meetingCard(m));
    root.appendChild(sec);
  }

  // Recent meetings
  if (data.recentMeetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Recent meetings"));
    for (const m of data.recentMeetings) sec.appendChild(window.meetingCard(m));
    root.appendChild(sec);
  }

  // Notes
  root.appendChild(notesSection({
    entityType: "person",
    entityId: personId,
    initialNotes: notesData.notes || [],
  }));

  main.appendChild(root);
}

// ── Person brief editor (the box at the top of a person page) ──────────────
function personBriefEditor(personId, brief) {
  const wrap = el("div", { class: "bg-white rounded-2xl ring-1 ring-slate-200 p-5 space-y-3" });
  const ta = el("textarea", {
    rows: 5,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: "Brief on this person… (or hit ✨ Generate to draft one with AI)",
  });
  ta.value = brief?.goalsMd || brief?.generatedMd || "";
  let saveTimer;
  ta.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api(\`/api/people/\${encodeURIComponent(personId)}/brief\`, {
          method: "PUT", body: { goalsMd: ta.value },
        });
      } catch (err) { toast(err.message, "err"); }
    }, 600);
  });
  const genBtn = el("button", {
    class: "text-xs text-indigo-600 hover:underline",
    onclick: async () => {
      genBtn.disabled = true; genBtn.textContent = "Generating…";
      try {
        const r = await api(\`/api/people/\${encodeURIComponent(personId)}/brief/generate\`, {
          method: "POST", body: {},
        });
        if (r.output) {
          ta.value = r.output;
          // Persist as goalsMd so a refresh keeps the editable copy.
          await api(\`/api/people/\${encodeURIComponent(personId)}/brief\`, {
            method: "PUT", body: { goalsMd: ta.value },
          });
        }
      } catch (err) { toast(err.message, "err"); }
      finally {
        genBtn.disabled = false; genBtn.textContent = "✨ Refresh";
      }
    },
  }, "✨ Refresh");
  wrap.appendChild(el("div", { class: "flex items-center justify-between" },
    el("h3", { class: "text-base font-semibold" }, "Person brief"),
    genBtn,
  ));
  wrap.appendChild(ta);
  return wrap;
}

// ── Notes section (reusable for person / project / task) ───────────────────
function notesSection({ entityType, entityId, initialNotes }) {
  const sec = el("section", { class: "space-y-2" });
  const newI = el("textarea", { rows: 2,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: "Add a note…" });
  const list = el("div", { class: "space-y-2" });
  function renderNote(n) {
    const ta = el("textarea", { rows: 2,
      class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none" });
    ta.value = n.body || "";
    let saveTimer;
    ta.addEventListener("input", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await api(\`/api/notes/\${encodeURIComponent(n.noteId)}\`, {
            method: "PATCH", body: { body: ta.value },
          });
        } catch (err) { toast(err.message, "err"); }
      }, 600);
    });
    const meta = el("div", { class: "flex items-center justify-between text-xs text-slate-400 mt-1" },
      el("span", {}, n.updatedAt ? "Updated " + fmtDate(n.updatedAt) : ""),
      el("button", { class: "text-rose-500 hover:underline",
        onclick: async () => {
          if (!confirm("Delete this note?")) return;
          try {
            await api(\`/api/notes/\${encodeURIComponent(n.noteId)}\`, { method: "DELETE", body: {} });
            wrap.remove();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Delete"),
    );
    const wrap = el("div", { class: "bg-white rounded-xl ring-1 ring-slate-200 p-3" }, ta, meta);
    return wrap;
  }
  for (const n of initialNotes) list.appendChild(renderNote(n));
  const addBtn = el("button", {
    class: "text-xs text-slate-500 hover:text-ink",
    onclick: async () => {
      if (!newI.value.trim()) return;
      try {
        const r = await api("/api/notes", { method: "POST", body: {
          entityType, entityId, body: newI.value,
        }});
        const created = { noteId: r.noteId, body: newI.value, updatedAt: new Date().toISOString() };
        list.insertBefore(renderNote(created), list.firstChild);
        newI.value = "";
      } catch (err) { toast(err.message, "err"); }
    },
  }, "+ Add note");
  sec.appendChild(el("h2", { class: "text-lg font-semibold" }, "Notes"));
  sec.appendChild(newI);
  sec.appendChild(el("div", { class: "flex justify-end" }, addBtn));
  sec.appendChild(list);
  return sec;
}

// ── Person detail modals ───────────────────────────────────────────────────
function openLinkProjectToPersonModal(personId, allProjects, onLinked) {
  if (!allProjects.length) { toast("No projects yet — create one first", "info"); return; }
  const sel = el("select", { class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white" });
  sel.appendChild(el("option", { value: "" }, "— Pick a project —"));
  for (const p of allProjects) sel.appendChild(el("option", { value: p.projectId }, p.name));
  const card = el("div", { class: "space-y-3" },
    el("h2", { class: "text-base font-semibold" }, "Link to existing project"),
    sel,
    el("div", { class: "flex justify-end gap-2" },
      el("button", { class: "px-3 py-1.5 text-sm rounded-lg ring-1 ring-slate-200",
        onclick: () => modal.close() }, "Cancel"),
      el("button", { class: "px-3 py-1.5 text-sm rounded-lg bg-ink text-white",
        onclick: async () => {
          if (!sel.value) { toast("Pick a project", "err"); return; }
          try {
            await api(\`/api/people/\${encodeURIComponent(personId)}/projects\`, {
              method: "POST", body: { projectId: sel.value },
            });
            modal.close(); toast("Linked", "ok");
            const linked = allProjects.find((p) => p.projectId === sel.value);
            if (linked) onLinked?.(linked);
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Link"),
    ),
  );
  const modal = openModal(card);
}

function openCreateProjectThenLinkModal(personId, onCreated) {
  const nameI = el("input", { type: "text", placeholder: "Project name", autofocus: true,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-base font-medium" });
  const descI = el("textarea", { rows: 2, placeholder: "Description…",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm resize-none" });
  const card = el("div", { class: "space-y-3" },
    el("h2", { class: "text-base font-semibold" }, "New project (linked)"),
    nameI, descI,
    el("div", { class: "flex justify-end" },
      el("button", { class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
        onclick: async () => {
          if (!nameI.value.trim()) { toast("Name required", "err"); return; }
          try {
            const r = await api("/api/projects", { method: "POST", body: {
              name: nameI.value.trim(), description: descI.value, stakeholderIds: [personId],
            }});
            modal.close(); toast("Created", "ok");
            const created = (r?.result?.results || []).find((x) => x.action === "created_project");
            onCreated?.({
              projectId: created?.projectId || \`tmp_\${Date.now()}\`,
              name: nameI.value.trim(),
            });
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Create"),
    ),
  );
  const modal = openModal(card);
}

async function openInvitePersonToMeetingModal(personId, personEmail, onDone) {
  if (!personEmail) {
    toast("This person has no email on file", "err");
    return;
  }
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 14);
  let meetings = [];
  try {
    const r = await api(\`/api/calendar?from=\${encodeURIComponent(from.toISOString())}&to=\${encodeURIComponent(to.toISOString())}\`);
    meetings = r.meetings || [];
  } catch (err) { toast(err.message, "err"); return; }
  if (!meetings.length) { toast("No upcoming meetings", "info"); return; }
  const sel = el("select", { class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white" });
  sel.appendChild(el("option", { value: "" }, "— Pick a meeting —"));
  for (const m of meetings) {
    const day = new Date(m.startTime).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    sel.appendChild(el("option", { value: m.eventId }, \`\${day} \${fmtTime(m.startTime)} — \${m.title || "(untitled)"}\`));
  }
  const card = el("div", { class: "space-y-3" },
    el("h2", { class: "text-base font-semibold" }, "Invite to existing meeting"),
    el("div", { class: "text-xs text-slate-500" }, "This will add " + personEmail + " to the calendar invite."),
    sel,
    el("div", { class: "flex justify-end gap-2" },
      el("button", { class: "px-3 py-1.5 text-sm rounded-lg ring-1 ring-slate-200",
        onclick: () => modal.close() }, "Cancel"),
      el("button", { class: "px-3 py-1.5 text-sm rounded-lg bg-ink text-white",
        onclick: async () => {
          if (!sel.value) { toast("Pick a meeting", "err"); return; }
          try {
            await api(\`/api/calendar/\${encodeURIComponent(sel.value)}\`, {
              method: "PATCH", body: { addAttendeeEmails: [personEmail] },
            });
            modal.close(); toast("Invited", "ok");
            const invited = meetings.find((m) => m.eventId === sel.value);
            if (invited) onDone?.(invited);
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Invite"),
    ),
  );
  const modal = openModal(card);
}

// ── Page: Triage ───────────────────────────────────────────────────────────
async function pageTriage(main) {
  const data = await api("/api/intake");
  const projects = (await api("/api/projects")).projects || [];
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-6" });

  // Live counter so the header reflects in-place removals.
  let remaining = data.count || (data.items || []).length;
  const counterEl = el("div", { class: "text-sm text-slate-500" },
    remaining + " pending · sorted by urgency");
  function decrementCounter() {
    remaining = Math.max(0, remaining - 1);
    counterEl.textContent = remaining + " pending · sorted by urgency";
    if (remaining === 0 && !cardsHost.querySelector("[data-triage-card]")) {
      cardsHost.appendChild(el("div", { class: "text-sm text-slate-500" }, "Inbox zero."));
    }
  }

  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, "Triage"), counterEl,
  ));
  root.appendChild(chatPromptBubbles([
    "Summarize what's in my triage queue and what to do first",
    "Bulk-dismiss anything that looks like newsletter spam",
    "Draft replies to the most urgent items",
  ]));
  const cardsHost = el("div", { class: "space-y-4" });
  root.appendChild(cardsHost);
  if (!data.items?.length) cardsHost.appendChild(el("div", { class: "text-sm text-slate-500" }, "Inbox zero."));
  for (const it of data.items || []) {
    cardsHost.appendChild(triageCard(it, projects, decrementCounter));
  }
  main.appendChild(root);
}

function triageCard(it, projects, onResolved) {
  const urg = Number(it.urgency || 0);
  const urgLabel = urg >= 5 ? "HIGH" : urg >= 2 ? "MED" : "LOW";
  const urgClass = urg >= 5 ? "bg-rose-100 text-rose-700"
                 : urg >= 2 ? "bg-amber-100 text-amber-800"
                 : "bg-slate-100 text-slate-500";
  const card = el("div", { class: "bg-white rounded-xl ring-1 ring-slate-200 p-4 space-y-2", "data-triage-card": "1" });
  function animateRemove() {
    card.style.transition = "opacity 200ms ease, max-height 250ms ease, margin 250ms ease, padding 250ms ease";
    card.style.pointerEvents = "none";
    card.style.maxHeight = card.offsetHeight + "px";
    requestAnimationFrame(() => {
      card.style.maxHeight = "0";
      card.style.marginTop = "0";
      card.style.marginBottom = "0";
      card.style.paddingTop = "0";
      card.style.paddingBottom = "0";
      card.style.opacity = "0";
    });
    setTimeout(() => { card.remove(); onResolved?.(); }, 260);
  }
  // Header: urgency badge + summary + kind
  const header = el("div", { class: "flex items-baseline justify-between gap-3" },
    el("div", { class: "flex items-baseline gap-2 min-w-0" },
      el("span", { class: \`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded \${urgClass} shrink-0\` }, urgLabel),
      el("div", { class: "text-sm font-medium truncate" }, it.subject || it.summary || "(no summary)"),
    ),
    el("div", { class: "text-xs text-slate-400 shrink-0 flex items-center gap-2" },
      it.kind ? el("span", {}, it.kind) : null,
      it.createdAt ? el("span", {}, fmtDate(it.createdAt)) : null,
    ),
  );
  card.appendChild(header);
  if (it.fromAddr) card.appendChild(el("div", { class: "text-xs text-slate-500 truncate" }, "From: " + it.fromAddr));
  if (it.sourceRef) card.appendChild(el("div", { class: "text-xs text-slate-400 truncate" }, it.sourceRef));
  // Body — collapsed by default, expand on click
  if (it.body) {
    const body = el("details", { class: "text-sm text-slate-700" },
      el("summary", { class: "cursor-pointer text-xs uppercase tracking-wide text-slate-500" }, "Body"),
      el("pre", { class: "mt-2 whitespace-pre-wrap font-sans text-sm bg-slate-50 rounded p-3 max-h-64 overflow-y-auto" }, it.body),
    );
    card.appendChild(body);
  }
  // Actions
  const actions = el("div", { class: "flex flex-wrap gap-2 pt-1" });
  actions.appendChild(el("button", {
    class: "text-xs px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100",
    onclick: async () => {
      const projectId = await pickProjectInline(projects);
      const title = prompt("Task title:", it.subject || it.summary || "");
      if (!title) return;
      try {
        const r = await api("/api/tasks", { method: "POST", body: {
          title, projectId, origin: "intake",
          sources: [{ sourceType: "intake", sourceRef: it.intakeId, excerpt: it.summary || "" }],
        }});
        const taskKey = r.result?.results?.find((x) => x.action === "create_task")?.details?.taskKey;
        await api("/api/intake/" + encodeURIComponent(it.intakeId) + "/resolve", {
          method: "POST", body: { linkedTaskKey: taskKey },
        });
        toast("Created task", "ok");
        animateRemove();
      } catch (err) { toast(err.message, "err"); }
    },
  }, "→ Task"));
  if (it.replyTo) {
    actions.appendChild(el("button", {
      class: "text-xs px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100",
      onclick: () => openTriageReplyModal(it),
    }, "↩ Reply"));
  }
  actions.appendChild(el("button", {
    class: "text-xs px-3 py-1 rounded-full bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100",
    onclick: async () => {
      if (!confirm("Dismiss?")) return;
      try {
        await api("/api/intake/" + encodeURIComponent(it.intakeId) + "/dismiss", { method: "POST", body: {} });
        toast("Dismissed", "ok");
        animateRemove();
      } catch (err) { toast(err.message, "err"); }
    },
  }, "Dismiss"));
  card.appendChild(actions);
  return card;
}

function openTriageReplyModal(it) {
  const toI = el("input", { type: "email", value: it.replyTo || it.fromAddr || "",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm" });
  const subjI = el("input", { type: "text",
    value: (it.subject || "").startsWith("Re:") ? it.subject : "Re: " + (it.subject || ""),
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm" });
  const bodyI = el("textarea", { rows: 8,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: "Type your reply…" });
  const note = el("div", { class: "text-xs text-slate-500" },
    "Saved to your Gmail drafts — you'll review and send from Gmail.");
  const card = el("div", { class: "space-y-3" },
    el("h2", { class: "text-base font-semibold" }, "Reply"),
    el("label", { class: "block text-xs uppercase tracking-wide text-slate-500" }, "To", toI),
    el("label", { class: "block text-xs uppercase tracking-wide text-slate-500" }, "Subject", subjI),
    el("label", { class: "block text-xs uppercase tracking-wide text-slate-500" }, "Body", bodyI),
    note,
    el("div", { class: "flex justify-end gap-2" },
      el("button", { class: "px-3 py-1.5 text-sm rounded-lg ring-1 ring-slate-200",
        onclick: () => modal.close() }, "Cancel"),
      el("button", { class: "px-3 py-1.5 text-sm rounded-lg bg-ink text-white",
        onclick: async () => {
          if (!toI.value || !bodyI.value) { toast("To and body required", "err"); return; }
          try {
            await api(\`/api/intake/\${encodeURIComponent(it.intakeId)}/reply\`, {
              method: "POST", body: {
                to: toI.value, subject: subjI.value, body: bodyI.value, threadId: it.threadId || "",
              },
            });
            modal.close(); toast("Draft saved to Gmail", "ok");
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Save draft"),
    ),
  );
  const modal = openModal(card);
}

// ── Chat prompt bubbles ────────────────────────────────────────────────────
// Renders a row of pre-baked prompts. Clicking one drops the text into the
// chat sidebar input and focuses it. The user can then edit + send.
function chatPromptBubbles(prompts) {
  const wrap = el("div", { class: "flex flex-wrap gap-2" });
  for (const p of prompts) {
    wrap.appendChild(el("button", {
      class: "text-xs px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100 hover:ring-indigo-400 transition",
      onclick: () => {
        if (window.fillChatInput) window.fillChatInput(p);
      },
    }, p));
  }
  return wrap;
}
window.chatPromptBubbles = chatPromptBubbles;

async function pickProjectInline(projects) {
  if (!projects.length) return "";
  return new Promise((resolve) => {
    const sel = el("select", { class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white" });
    sel.appendChild(el("option", { value: "" }, "— No project —"));
    for (const p of projects) sel.appendChild(el("option", { value: p.projectId }, p.name));
    const card = el("div", { class: "space-y-3" },
      el("h2", { class: "text-base font-semibold" }, "Link to project (optional)"),
      sel,
      el("div", { class: "flex justify-end gap-2" },
        el("button", { class: "px-3 py-1.5 text-sm rounded-lg ring-1 ring-slate-200",
          onclick: () => { modal.close(); resolve(""); } }, "Skip"),
        el("button", { class: "px-3 py-1.5 text-sm rounded-lg bg-ink text-white",
          onclick: () => { modal.close(); resolve(sel.value); } }, "OK"),
      ),
    );
    const modal = openModal(card);
  });
}

// ── Page: Goals ────────────────────────────────────────────────────────────
// Quarterly OKR-style goals. The page lists every goal (open + closed) with
// inline status / priority controls, opens an editor modal on click, lets
// the user mark complete (status=achieved), and supports row delete.
const GOAL_STATUSES = ["active", "achieved", "missed", "dropped"];
const GOAL_PRIORITIES = ["", "high", "medium", "low"];

function goalStatusBadge(status) {
  const s = String(status || "active").toLowerCase();
  const cls = s === "achieved" ? "bg-emerald-100 text-emerald-700"
            : s === "missed"   ? "bg-rose-100 text-rose-700"
            : s === "dropped"  ? "bg-slate-100 text-slate-500"
            :                    "bg-indigo-100 text-indigo-700";
  return el("span", {
    class: "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded " + cls,
  }, s);
}

function isGoalOpen(g) {
  const s = String(g.status || "").toLowerCase();
  return !s || s === "active";
}

async function pageGoals(main) {
  const data = await api("/api/goals?includeClosed=1");
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-6" });

  // Section refs so newly-created goals can appear in place without a route.
  const activeListHost = el("div", { class: "space-y-2" });
  const closedListHost = el("div", { class: "space-y-2" });
  let activeEmptyEl = null;
  let closedEmptyEl = null;

  function appendCreatedGoal(g) {
    if (activeEmptyEl && activeEmptyEl.parentNode) {
      activeEmptyEl.remove();
      activeEmptyEl = null;
    }
    activeListHost.insertBefore(goalRow(g), activeListHost.firstChild);
  }

  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, "Goals"),
    el("button", {
      class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openGoalEditorModal(null, { onCreated: appendCreatedGoal }),
    }, "+ New goal"),
  ));
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "Which goals are at risk this quarter?",
    "Summarize progress on my active goals",
    "Draft success criteria for a new goal",
  ]));

  const goals = data.goals || [];
  const open = goals.filter(isGoalOpen);
  const closed = goals.filter((g) => !isGoalOpen(g));

  function buildSection(title, host, items, emptyRef, helpText) {
    const sec = el("section", { class: "space-y-2" });
    sec.appendChild(el("div", { class: "flex items-baseline justify-between mb-1" },
      el("h2", { class: "text-lg font-semibold" }, title),
      el("span", { class: "text-xs text-slate-400" }, items.length + (helpText ? " · " + helpText : "")),
    ));
    if (!items.length) {
      const emptyEl = el("div", { class: "text-sm text-slate-500" }, "Nothing here.");
      host.appendChild(emptyEl);
      emptyRef(emptyEl);
    }
    for (const g of items) host.appendChild(goalRow(g));
    sec.appendChild(host);
    return sec;
  }

  if (!goals.length) {
    root.appendChild(el("div", { class: "text-sm text-slate-500" },
      "No goals yet. Click + New goal to set your first quarterly objective."));
    // Still attach hosts so a newly-created goal can land in place.
    root.appendChild(activeListHost);
  } else {
    root.appendChild(buildSection("Active", activeListHost, open,
      (e) => { activeEmptyEl = e; }));
    if (closed.length) root.appendChild(buildSection("Closed", closedListHost, closed,
      (e) => { closedEmptyEl = e; }, "achieved · missed · dropped"));
  }
  main.appendChild(root);
}

function goalRow(g) {
  let row;
  let titleEl, descEl;
  let metaEl;

  function animateRemove() {
    if (!row) return;
    row.style.transition = "opacity 200ms ease, max-height 250ms ease, margin 250ms ease, padding 250ms ease";
    row.style.pointerEvents = "none";
    row.style.maxHeight = row.offsetHeight + "px";
    requestAnimationFrame(() => {
      row.style.maxHeight = "0";
      row.style.marginTop = "0";
      row.style.marginBottom = "0";
      row.style.paddingTop = "0";
      row.style.paddingBottom = "0";
      row.style.opacity = "0";
    });
    setTimeout(() => row.remove(), 260);
  }

  function buildMeta() {
    return el("div", { class: "flex items-center gap-2 mt-0.5 text-xs text-slate-500" },
      goalStatusBadge(g.status),
      g.quarter ? el("span", {}, g.quarter) : null,
      g.priority ? el("span", { class: "uppercase tracking-wide" }, g.priority) : null,
      g.targetDate ? el("span", {}, "due " + fmtDate(g.targetDate)) : null,
    );
  }
  function applySaved(updated) {
    Object.assign(g, updated);
    titleEl.textContent = g.title || "(untitled goal)";
    if (descEl) descEl.textContent = g.description || "";
    const fresh = buildMeta();
    metaEl.replaceWith(fresh);
    metaEl = fresh;
    if (!isGoalOpen(g) && row?.parentNode) animateRemove();
  }

  const completeBtn = isGoalOpen(g) ? el("button", {
    class: "shrink-0 w-5 h-5 rounded-full border-2 border-slate-300 hover:border-emerald-500 transition flex items-center justify-center",
    title: "Mark goal achieved",
    onclick: async (e) => {
      e.stopPropagation();
      if (!confirm("Mark this goal as achieved?")) return;
      try {
        await api("/api/goals/" + encodeURIComponent(g.goalId) + "/complete", { method: "POST", body: {} });
        toast("Goal achieved", "ok");
        animateRemove();
      } catch (err) { toast(err.message, "err"); }
    },
  }) : el("span", { class: "shrink-0 w-5 h-5 rounded-full bg-emerald-500 text-white text-xs flex items-center justify-center", title: g.status }, "✓");

  const deleteBtn = el("button", {
    class: "text-xs text-slate-400 hover:text-rose-600 px-2 shrink-0",
    title: "Delete goal",
    onclick: async (e) => {
      e.stopPropagation();
      if (!confirm("Delete \\"" + (g.title || "this goal") + "\\"? This cannot be undone.")) return;
      try {
        await api("/api/goals/" + encodeURIComponent(g.goalId), { method: "DELETE", body: {} });
        toast("Deleted", "ok");
        animateRemove();
      } catch (err) { toast(err.message, "err"); }
    },
  }, "✕");

  metaEl = buildMeta();
  titleEl = el("div", { class: "text-sm font-medium text-ink truncate" }, g.title || "(untitled goal)");
  descEl = el("div", { class: "text-xs text-slate-500 mt-1 truncate" }, g.description || "");
  if (!g.description) descEl.style.display = "none";

  row = el("div", {
    class: "group flex items-center gap-3 py-2.5 px-3 -mx-3 rounded-lg bg-white ring-1 ring-slate-200 hover:ring-indigo-300 cursor-pointer transition",
    onclick: () => openGoalEditorModal(g, {
      onSaved: applySaved,
      onCompleted: animateRemove,
      onDeleted: animateRemove,
    }),
  },
    completeBtn,
    el("div", { class: "flex-1 min-w-0" }, titleEl, metaEl, descEl),
    deleteBtn,
  );
  return row;
}

function openGoalEditorModal(goal, opts) {
  // Back-compat: callers used to pass a single onDone fn. New callers pass
  // { onCreated, onSaved, onCompleted, onDeleted } so the page can update
  // in place rather than triggering a full route().
  const callbacks = (typeof opts === "function") ? { onDone: opts } : (opts || {});
  const { onDone, onCreated, onSaved, onCompleted, onDeleted } = callbacks;
  const isNew = !goal;
  const titleI = el("input", {
    type: "text", value: goal?.title || "", placeholder: "Goal title", autofocus: true,
    class: "w-full text-lg font-medium rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none",
  });
  const descI = el("textarea", {
    rows: 3, placeholder: "What's the goal? Why does it matter?",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
  });
  descI.value = goal?.description || "";

  const quarterI = el("input", {
    type: "text", value: goal?.quarter || "", placeholder: "e.g. 2026Q2",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm",
  });
  const targetI = el("input", {
    type: "date", value: (goal?.targetDate || "").slice(0, 10),
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm",
  });

  const statusI = el("select", { class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white text-sm" });
  for (const s of GOAL_STATUSES) {
    const o = el("option", { value: s }, s);
    if ((goal?.status || "active") === s) o.selected = true;
    statusI.appendChild(o);
  }
  const priI = el("select", { class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white text-sm" });
  for (const p of GOAL_PRIORITIES) {
    const o = el("option", { value: p }, p || "—");
    if ((goal?.priority || "") === p) o.selected = true;
    priI.appendChild(o);
  }

  const successI = el("textarea", {
    rows: 3, placeholder: "How will you know this is achieved?",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
  });
  successI.value = goal?.successCriteria || "";

  const notesI = el("textarea", {
    rows: 3, placeholder: "Notes…",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
  });
  notesI.value = goal?.notes || "";

  const fieldLabel = (text, node) => el("label", { class: "block text-xs uppercase tracking-wide text-slate-500" }, text, node);

  const card = el("div", { class: "space-y-4" },
    el("h2", { class: "text-xl font-semibold" }, isNew ? "New goal" : "Edit goal"),
    titleI,
    fieldLabel("Description", descI),
    el("div", { class: "grid grid-cols-2 gap-3" },
      fieldLabel("Quarter", quarterI),
      fieldLabel("Target date", targetI),
    ),
    el("div", { class: "grid grid-cols-2 gap-3" },
      fieldLabel("Status", statusI),
      fieldLabel("Priority", priI),
    ),
    fieldLabel("Success criteria", successI),
    fieldLabel("Notes", notesI),
    el("div", { class: "flex justify-between items-center pt-2 gap-3" },
      isNew ? el("span", {}) : el("button", {
        class: "text-sm text-rose-600 hover:underline",
        onclick: async () => {
          if (!confirm("Delete this goal? This cannot be undone.")) return;
          try {
            await api("/api/goals/" + encodeURIComponent(goal.goalId), { method: "DELETE", body: {} });
            modal.close(); toast("Deleted", "ok");
            if (onDeleted) onDeleted(); else onDone?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Delete"),
      el("div", { class: "flex gap-2" },
        !isNew && isGoalOpen(goal) ? el("button", {
          class: "rounded-lg ring-1 ring-emerald-300 text-emerald-700 px-4 py-2 text-sm font-medium hover:bg-emerald-50",
          onclick: async () => {
            try {
              await api("/api/goals/" + encodeURIComponent(goal.goalId) + "/complete", { method: "POST", body: {} });
              modal.close(); toast("Goal achieved", "ok");
              if (onCompleted) onCompleted(); else onDone?.();
            } catch (err) { toast(err.message, "err"); }
          },
        }, "Mark achieved") : null,
        el("button", {
          class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
          onclick: async () => {
            const title = titleI.value.trim();
            if (!title) { toast("Title required", "err"); return; }
            const targetDate = targetI.value ? new Date(targetI.value).toISOString() : "";
            const patch = {
              title, description: descI.value, quarter: quarterI.value,
              status: statusI.value, priority: priI.value, targetDate,
              successCriteria: successI.value, notes: notesI.value,
            };
            try {
              if (isNew) {
                const r = await api("/api/goals", { method: "POST", body: patch });
                toast("Created", "ok");
                modal.close();
                if (onCreated) {
                  const created = (r?.result?.results || []).find((x) => x.action === "created_goal");
                  onCreated({
                    goalId: created?.goalId || \`tmp_\${Date.now()}\`,
                    ...patch,
                  });
                } else {
                  onDone?.();
                }
              } else {
                await api("/api/goals/" + encodeURIComponent(goal.goalId), {
                  method: "PATCH", body: { patch },
                });
                toast("Saved", "ok");
                modal.close();
                if (onSaved) onSaved(patch); else onDone?.();
              }
            } catch (err) { toast(err.message, "err"); }
          },
        }, isNew ? "Create" : "Save"),
      ),
    ),
  );
  const modal = openModal(card);
}

// ── Wire pages + nav into the kit's router ─────────────────────────────────
// The kit's spa-core handles shell rendering, default chat sidebar, and
// boot. We just declare which pages exist and which hashes route to them.
window.openCreateTaskModal = openCreateTaskModal;
window.pageProjects = pageProjects;
window.pageProjectDetail = pageProjectDetail;
window.pagePeople = pagePeople;
window.pagePersonDetail = pagePersonDetail;
window.pageTriage = pageTriage;
window.pageGoals = pageGoals;

window.AGENT_BRAND = { mark: "✦", label: "Chief" };
window.NAV = [
  { hash: "#/now",      label: "Now" },
  { hash: "#/today",    label: "Today" },
  { hash: "#/week",     label: "This Week" },
  { hash: "#/goals",    label: "Goals" },
  { hash: "#/projects", label: "Projects" },
  { hash: "#/people",   label: "People" },
  { hash: "#/triage",   label: "Triage" },
];

// Pull runtime config and append Ideas to the nav if the worker has an
// IDEAS_URL configured. Re-render nav on success.
api("/api/config").then((cfg) => {
  if (cfg?.ideasUrl) {
    window.NAV.push({ hash: cfg.ideasUrl, label: "Ideas", target: "_blank" });
    window.__cos.route();
  }
}).catch(() => {});
window.ROUTES = [
  { pattern: /^#\\/now$/,             handler: "pageNow" },
  { pattern: /^#\\/today$/,           handler: "pageToday" },
  { pattern: /^#\\/week$/,            handler: "pageWeek" },
  { pattern: /^#\\/goals$/,           handler: "pageGoals" },
  { pattern: /^#\\/projects$/,        handler: "pageProjects" },
  { pattern: /^#\\/projects\\/(.+)$/,  handler: "pageProjectDetail" },
  { pattern: /^#\\/people$/,          handler: "pagePeople" },
  { pattern: /^#\\/people\\/(.+)$/,    handler: "pagePersonDetail" },
  { pattern: /^#\\/triage$/,          handler: "pageTriage" },
];
`;
