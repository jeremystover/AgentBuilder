/**
 * web/spa-pages2.js — chief-of-staff page renderers (Projects, People,
 * Triage), per-page modals, and the NAV / ROUTES / AGENT_BRAND wiring
 * that the kit's router consumes.
 *
 * Concatenated after the kit's SPA_CORE_JS and spa-pages.js into
 * /app/app.js.
 */

export const SPA_PAGES2_JS = String.raw`
const $$ = window.__cos;
const { el, fmtDate, fmtTime, api, toast, openModal, attachVoice } = $$;

// ── Create-task modal (referenced by Today/Week + chat callbacks) ──────────
async function openCreateTaskModal({ projectsById = {}, onChanged } = {}) {
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
            await api("/api/tasks", { method: "POST", body: {
              title: titleI.value.trim(),
              dueAt: dueI.value ? new Date(dueI.value).toISOString() : "",
              priority: priI.value, projectId: projI.value,
              notes: notesI.value, origin: "manual",
            }});
            modal.close(); toast("Created", "ok"); onChanged?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Create"),
    ),
  );
  const modal = openModal(card);
}

// ── Page: Projects (list) ──────────────────────────────────────────────────
async function pageProjects(main) {
  const data = await api("/api/projects");
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-6" });
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, "Projects"),
    el("button", {
      class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openCreateProjectModal({ onChanged: () => $$.route() }),
    }, "+ New project"),
  ));
  const grid = el("div", { class: "grid gap-3" });
  if (!data.projects?.length) {
    grid.appendChild(el("div", { class: "text-sm text-slate-500" }, "No projects yet."));
  }
  for (const p of data.projects || []) {
    const health = (p.healthStatus || "").toLowerCase();
    const dot = health === "off_track" ? "bg-rose-500"
              : health === "at_risk"   ? "bg-amber-500"
              : health === "on_track"  ? "bg-emerald-500"
              : "bg-slate-300";
    grid.appendChild(el("a", {
      href: "#/projects/" + encodeURIComponent(p.projectId),
      class: "block bg-white rounded-xl ring-1 ring-slate-200 hover:ring-indigo-300 p-4 transition",
    },
      el("div", { class: "flex items-center gap-3" },
        el("span", { class: "w-2 h-2 rounded-full " + dot }),
        el("div", { class: "flex-1 text-base font-medium text-ink" }, p.name || "(untitled)"),
        el("span", { class: "text-xs text-slate-400" }, p.status || ""),
      ),
      p.nextMilestoneAt ? el("div", { class: "text-xs text-slate-500 mt-1" }, "Next milestone " + fmtDate(p.nextMilestoneAt)) : null,
    ));
  }
  root.appendChild(grid);
  main.appendChild(root);
}

function openCreateProjectModal({ onChanged } = {}) {
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
            await api("/api/projects", { method: "POST", body: { name: nameI.value.trim(), description: descI.value } });
            modal.close(); toast("Created", "ok"); onChanged?.();
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
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, data.name || "(untitled project)"),
    el("span", { class: "text-sm text-slate-500" }, (data.status || "") + (data.healthStatus ? " · " + data.healthStatus : "")),
  ));

  // Stakeholders
  const peopleById = Object.fromEntries((peopleData.people || []).map((p) => [p.stakeholderId, p]));
  const stakeholdersSec = el("section", { class: "space-y-3" });
  stakeholdersSec.appendChild(el("div", { class: "flex items-baseline justify-between" },
    el("h2", { class: "text-lg font-semibold" }, "Stakeholders"),
    el("button", { class: "text-xs text-slate-500 hover:text-ink",
      onclick: () => openAddStakeholderToProjectModal(projectId, peopleData.people || [], () => $$.route()) },
      "+ Add stakeholder"),
  ));
  const stakeholderRow = el("div", { class: "flex flex-wrap gap-2" });
  for (const sh of data.stakeholders || []) {
    stakeholderRow.appendChild(el("a", {
      href: "#/people/" + encodeURIComponent(sh.stakeholderId || sh.email || sh.name),
      class: "px-3 py-1.5 bg-white rounded-full ring-1 ring-slate-200 text-sm hover:ring-indigo-300",
    }, sh.name || sh.email));
  }
  if (!data.stakeholders?.length) stakeholderRow.appendChild(el("div", { class: "text-sm text-slate-500" }, "None yet."));
  stakeholdersSec.appendChild(stakeholderRow);
  root.appendChild(stakeholdersSec);

  // Tasks
  const tasksSec = el("section", { class: "space-y-1" });
  tasksSec.appendChild(el("div", { class: "flex items-baseline justify-between mb-2" },
    el("h2", { class: "text-lg font-semibold" }, "Open tasks"),
    el("button", { class: "text-xs text-slate-500 hover:text-ink",
      onclick: () => openCreateTaskModal({ projectsById: { [projectId]: { projectId, name: data.name } }, onChanged: () => $$.route() }) },
      "+ Add task"),
  ));
  if (!data.openTasks?.length) tasksSec.appendChild(el("div", { class: "text-sm text-slate-500" }, "No open tasks."));
  for (const t of data.openTasks || []) {
    tasksSec.appendChild(window.taskRow(t, { showProject: false, onChanged: () => $$.route() }));
  }
  root.appendChild(tasksSec);

  // Meetings
  if (data.recentMeetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Recent meetings"));
    for (const m of data.recentMeetings) {
      sec.appendChild(el("div", { class: "bg-white rounded-xl ring-1 ring-slate-200 p-3" },
        el("div", { class: "text-sm font-medium" }, m.title || "(untitled)"),
        el("div", { class: "text-xs text-slate-500" }, fmtDate(m.startTime) + " · " + fmtTime(m.startTime)),
      ));
    }
    root.appendChild(sec);
  }
  const addMeetingBtn = el("button", {
    class: "text-sm text-slate-500 hover:text-ink",
    onclick: () => openCreateMeetingModal({ projectName: data.name, stakeholders: data.stakeholders || [] }),
  }, "+ Schedule meeting");
  root.appendChild(addMeetingBtn);

  main.appendChild(root);
}

function openAddStakeholderToProjectModal(projectId, allPeople, onDone) {
  const sel = el("select", { class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white" });
  sel.appendChild(el("option", { value: "" }, "— Pick existing —"));
  for (const p of allPeople) sel.appendChild(el("option", { value: p.stakeholderId }, p.name || p.email));
  const newName = el("input", { type: "text", placeholder: "Or new name", class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2" });
  const newEmail = el("input", { type: "email", placeholder: "New email", class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2" });
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
            if (!id && (newName.value || newEmail.value)) {
              const r = await api("/api/people", { method: "POST", body: { name: newName.value, email: newEmail.value } });
              id = r.stakeholderId;
            }
            if (!id) { toast("Pick or create a person", "err"); return; }
            // Append to project's stakeholderIds
            const cur = await api("/api/projects/" + encodeURIComponent(projectId));
            const ids = new Set([...(cur.stakeholders || []).map((s) => s.stakeholderId), id].filter(Boolean));
            await api("/api/projects/" + encodeURIComponent(projectId), {
              method: "PATCH", body: { patch: {}, stakeholderIds: [...ids] }
            });
            modal.close(); toast("Added", "ok"); onDone?.();
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

// ── Page: People (list) ────────────────────────────────────────────────────
async function pagePeople(main) {
  const data = await api("/api/people");
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-6" });
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, "People"),
    el("button", { class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openCreatePersonModal({ onDone: () => $$.route() }) }, "+ New person"),
  ));
  if (!data.people?.length) root.appendChild(el("div", { class: "text-sm text-slate-500" }, "No stakeholders yet."));
  const list = el("div", { class: "grid gap-2" });
  for (const p of data.people || []) {
    list.appendChild(el("a", {
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
    ));
  }
  root.appendChild(list);
  main.appendChild(root);
}

function openCreatePersonModal({ onDone } = {}) {
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
            await api("/api/people", { method: "POST", body: { name: nameI.value, email: emailI.value, tierTag: tierI.value } });
            modal.close(); toast("Added", "ok"); onDone?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Add"),
    ),
  );
  const modal = openModal(card);
}

async function pagePersonDetail(main, personId) {
  const data = await api("/api/people/" + encodeURIComponent(personId));
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-8" });
  root.appendChild(el("a", { href: "#/people", class: "text-xs text-slate-500 hover:text-ink" }, "← People"));
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, data.name || data.email || personId),
    el("span", { class: "text-sm text-slate-500" }, data.tierTag || ""),
  ));
  if (data.email) root.appendChild(el("div", { class: "text-sm text-slate-500" }, data.email));

  if (data.openTasks?.length) {
    const sec = el("section", { class: "space-y-1" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Open tasks"));
    for (const t of data.openTasks) sec.appendChild(window.taskRow(t, { onChanged: () => $$.route() }));
    root.appendChild(sec);
  }

  if (data.projects?.length) {
    const sec = el("section", { class: "space-y-2" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Projects"));
    for (const p of data.projects) {
      sec.appendChild(el("a", {
        href: "#/projects/" + encodeURIComponent(p.projectId),
        class: "block bg-white rounded-xl ring-1 ring-slate-200 hover:ring-indigo-300 p-3 px-4 text-sm",
      }, p.name));
    }
    root.appendChild(sec);
  }

  if (data.recentMeetings?.length) {
    const sec = el("section", { class: "space-y-2" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Recent meetings"));
    for (const m of data.recentMeetings) {
      sec.appendChild(el("div", { class: "bg-white rounded-xl ring-1 ring-slate-200 p-3 text-sm" },
        el("div", { class: "font-medium" }, m.title || "(untitled)"),
        el("div", { class: "text-xs text-slate-500" }, fmtDate(m.startTime))));
    }
    root.appendChild(sec);
  }

  main.appendChild(root);
}

// ── Page: Triage ───────────────────────────────────────────────────────────
async function pageTriage(main) {
  const data = await api("/api/intake");
  const projects = (await api("/api/projects")).projects || [];
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-6" });
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, "Triage"),
    el("span", { class: "text-sm text-slate-500" }, (data.count || 0) + " pending"),
  ));
  if (!data.items?.length) root.appendChild(el("div", { class: "text-sm text-slate-500" }, "Inbox zero."));
  for (const it of data.items || []) {
    const card = el("div", { class: "bg-white rounded-xl ring-1 ring-slate-200 p-4 space-y-2" });
    card.appendChild(el("div", { class: "flex items-baseline justify-between gap-3" },
      el("div", { class: "text-sm font-medium truncate" }, it.summary || "(no summary)"),
      el("span", { class: "text-xs text-slate-400 shrink-0" }, it.kind || ""),
    ));
    if (it.sourceRef) card.appendChild(el("div", { class: "text-xs text-slate-500 truncate" }, it.sourceRef));
    const actions = el("div", { class: "flex gap-2 pt-1" },
      el("button", {
        class: "text-xs px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100",
        onclick: async () => {
          const projectId = await pickProjectInline(projects);
          const title = prompt("Task title:", it.summary || "");
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
            toast("Created task", "ok"); $$.route();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "→ Task"),
      el("button", {
        class: "text-xs px-3 py-1 rounded-full bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100",
        onclick: async () => {
          if (!confirm("Dismiss?")) return;
          try {
            await api("/api/intake/" + encodeURIComponent(it.intakeId) + "/dismiss", { method: "POST", body: {} });
            toast("Dismissed", "ok"); $$.route();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Dismiss"),
    );
    card.appendChild(actions);
    root.appendChild(card);
  }
  main.appendChild(root);
}

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

// ── Wire pages + nav into the kit's router ─────────────────────────────────
// The kit's spa-core handles shell rendering, default chat sidebar, and
// boot. We just declare which pages exist and which hashes route to them.
window.openCreateTaskModal = openCreateTaskModal;
window.pageProjects = pageProjects;
window.pageProjectDetail = pageProjectDetail;
window.pagePeople = pagePeople;
window.pagePersonDetail = pagePersonDetail;
window.pageTriage = pageTriage;

window.AGENT_BRAND = { mark: "✦", label: "Chief" };
window.NAV = [
  { hash: "#/today",    label: "Today" },
  { hash: "#/week",     label: "This Week" },
  { hash: "#/projects", label: "Projects" },
  { hash: "#/people",   label: "People" },
  { hash: "#/triage",   label: "Triage" },
];
window.ROUTES = [
  { pattern: /^#\/today$/,           handler: "pageToday" },
  { pattern: /^#\/week$/,            handler: "pageWeek" },
  { pattern: /^#\/projects$/,        handler: "pageProjects" },
  { pattern: /^#\/projects\/(.+)$/,  handler: "pageProjectDetail" },
  { pattern: /^#\/people$/,          handler: "pagePeople" },
  { pattern: /^#\/people\/(.+)$/,    handler: "pagePersonDetail" },
  { pattern: /^#\/triage$/,          handler: "pageTriage" },
];
`;
