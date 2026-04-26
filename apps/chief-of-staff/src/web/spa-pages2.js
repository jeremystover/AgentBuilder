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
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "Which projects need attention this week?",
    "Summarize the status of each project",
    "What projects are blocked and why?",
  ]));
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
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "What's the latest on this project?",
    "What are the risks?",
    "Draft a status update",
  ]));

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
    // Backend hydrates {stakeholderId, name, email, tierTag}. Fall through
    // name → email → id so the pill always shows something a human recognizes.
    const id = sh.stakeholderId || sh.id || sh.email || sh.name || "";
    const label = sh.name || sh.email || sh.stakeholderId || "(unnamed)";
    const sub = sh.email && sh.name ? sh.email : "";
    stakeholderRow.appendChild(el("a", {
      href: "#/people/" + encodeURIComponent(id),
      class: "px-3 py-1.5 bg-white rounded-full ring-1 ring-slate-200 text-sm hover:ring-indigo-300 inline-flex items-baseline gap-2",
      title: sub || label,
    },
      el("span", { class: "text-ink" }, label),
      sub ? el("span", { class: "text-xs text-slate-400" }, sub) : null,
    ));
  }
  if (!data.stakeholders?.length) stakeholderRow.appendChild(el("div", { class: "text-sm text-slate-500" }, "None yet."));
  stakeholdersSec.appendChild(stakeholderRow);
  root.appendChild(stakeholdersSec);

  // Tasks (with show-completed toggle scoped to this project)
  const tasksSec = el("section", { class: "space-y-1" });
  const showDone = window.showCompletedFlag("project:" + projectId);
  tasksSec.appendChild(el("div", { class: "flex items-baseline justify-between mb-2 gap-3" },
    el("h2", { class: "text-lg font-semibold" }, "Open tasks"),
    el("div", { class: "flex items-center gap-2" },
      window.showCompletedToggle("project:" + projectId, () => $$.route()),
      el("button", { class: "text-xs text-slate-500 hover:text-ink",
        onclick: () => openCreateTaskModal({ projectsById: { [projectId]: { projectId, name: data.name } }, onChanged: () => $$.route() }) },
        "+ Add task"),
    ),
  ));
  if (!data.openTasks?.length) tasksSec.appendChild(el("div", { class: "text-sm text-slate-500" }, "No open tasks."));
  for (const t of data.openTasks || []) {
    tasksSec.appendChild(window.taskRow(t, { showProject: false, onChanged: () => $$.route() }));
  }
  if (showDone) {
    try {
      const done = await api("/api/tasks/completed?scope=all&projectId=" + encodeURIComponent(projectId));
      if (done.tasks?.length) {
        tasksSec.appendChild(el("h3", { class: "text-xs uppercase tracking-wide text-slate-400 mt-4" }, "Completed"));
        for (const t of done.tasks) tasksSec.appendChild(window.taskRow(t, { showProject: false, onChanged: () => $$.route() }));
      }
    } catch (err) { /* surfaced elsewhere */ }
  }
  root.appendChild(tasksSec);

  // Meetings — upcoming, then recent. Reuses the rich meetingCard from
  // spa-pages.js so day-of-week, calendar invite, and Zoom links render
  // the same everywhere.
  if (data.upcomingMeetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Upcoming meetings"));
    for (const m of data.upcomingMeetings) sec.appendChild(window.meetingCard(m, { onChanged: () => $$.route() }));
    root.appendChild(sec);
  }
  if (data.recentMeetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Recent meetings"));
    for (const m of data.recentMeetings) sec.appendChild(window.meetingCard(m, { onChanged: () => $$.route() }));
    root.appendChild(sec);
  }
  const meetingActions = el("div", { class: "flex gap-4" },
    el("button", {
      class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openCreateMeetingModal({ projectName: data.name, stakeholders: data.stakeholders || [] }),
    }, "+ Schedule meeting"),
    el("button", {
      class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openLinkMeetingModal(projectId, () => $$.route()),
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
            modal.close(); toast("Linked", "ok"); onDone?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Link"),
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
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "Who haven't I touched in a while?",
    "Top 5 stakeholders to check in with",
    "Draft a 1:1 prep for my next meeting",
  ]));
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
    for (const t of data.openTasks) sec.appendChild(window.taskRow(t, { onChanged: () => $$.route() }));
    root.appendChild(sec);
  }

  // Projects (linked) + actions
  {
    const sec = el("section", { class: "space-y-2" });
    sec.appendChild(el("div", { class: "flex items-baseline justify-between" },
      el("h2", { class: "text-lg font-semibold" }, "Projects"),
      el("div", { class: "flex gap-3 text-xs" },
        el("button", { class: "text-slate-500 hover:text-ink",
          onclick: () => openLinkProjectToPersonModal(personId, allProjects.projects || [], () => $$.route()),
        }, "+ Link existing"),
        el("button", { class: "text-slate-500 hover:text-ink",
          onclick: () => openCreateProjectThenLinkModal(personId, () => $$.route()),
        }, "+ New project"),
      ),
    ));
    if (!data.projects?.length) {
      sec.appendChild(el("div", { class: "text-sm text-slate-500" }, "No projects linked."));
    }
    for (const p of data.projects || []) {
      sec.appendChild(el("a", {
        href: "#/projects/" + encodeURIComponent(p.projectId),
        class: "block bg-white rounded-xl ring-1 ring-slate-200 hover:ring-indigo-300 p-3 px-4 text-sm",
      }, p.name));
    }
    root.appendChild(sec);
  }

  // Upcoming meetings
  {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("div", { class: "flex items-baseline justify-between" },
      el("h2", { class: "text-lg font-semibold" }, "Upcoming meetings"),
      el("div", { class: "flex gap-3 text-xs" },
        el("button", { class: "text-slate-500 hover:text-ink",
          onclick: () => openInvitePersonToMeetingModal(personId, data.email, () => $$.route()),
        }, "+ Invite to existing"),
        el("button", { class: "text-slate-500 hover:text-ink",
          onclick: () => openCreateMeetingModal({ projectName: "", stakeholders: data.email ? [{ email: data.email, name: data.name }] : [] }),
        }, "+ Schedule new"),
      ),
    ));
    if (!data.upcomingMeetings?.length) {
      sec.appendChild(el("div", { class: "text-sm text-slate-500" }, "Nothing on the calendar."));
    }
    for (const m of data.upcomingMeetings || []) sec.appendChild(window.meetingCard(m, { onChanged: () => $$.route() }));
    root.appendChild(sec);
  }

  // Recent meetings — backend re-projects from the Meetings table so the
  // rich card (links, click-to-edit) lights up here too.
  if (data.recentMeetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Recent meetings"));
    for (const m of data.recentMeetings) sec.appendChild(window.meetingCard(m, { onChanged: () => $$.route() }));
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
function openLinkProjectToPersonModal(personId, allProjects, onDone) {
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
            modal.close(); toast("Linked", "ok"); onDone?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Link"),
    ),
  );
  const modal = openModal(card);
}

function openCreateProjectThenLinkModal(personId, onDone) {
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
            modal.close(); toast("Created", "ok"); onDone?.();
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
            modal.close(); toast("Invited", "ok"); onDone?.();
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
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, "Triage"),
    el("div", { class: "text-sm text-slate-500" },
      (data.count || 0) + " pending · sorted by urgency"),
  ));
  root.appendChild(chatPromptBubbles([
    "Summarize what's in my triage queue and what to do first",
    "Bulk-dismiss anything that looks like newsletter spam",
    "Draft replies to the most urgent items",
  ]));
  if (!data.items?.length) root.appendChild(el("div", { class: "text-sm text-slate-500" }, "Inbox zero."));
  for (const it of data.items || []) {
    root.appendChild(triageCard(it, projects));
  }
  main.appendChild(root);
}

function triageCard(it, projects) {
  const urg = Number(it.urgency || 0);
  const urgLabel = urg >= 5 ? "HIGH" : urg >= 2 ? "MED" : "LOW";
  const urgClass = urg >= 5 ? "bg-rose-100 text-rose-700"
                 : urg >= 2 ? "bg-amber-100 text-amber-800"
                 : "bg-slate-100 text-slate-500";
  const card = el("div", { class: "bg-white rounded-xl ring-1 ring-slate-200 p-4 space-y-2" });
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
        toast("Created task", "ok"); $$.route();
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
        toast("Dismissed", "ok"); $$.route();
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
  { hash: "#/now",      label: "Now" },
  { hash: "#/today",    label: "Today" },
  { hash: "#/week",     label: "This Week" },
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
  { pattern: /^#\\/projects$/,        handler: "pageProjects" },
  { pattern: /^#\\/projects\\/(.+)$/,  handler: "pageProjectDetail" },
  { pattern: /^#\\/people$/,          handler: "pagePeople" },
  { pattern: /^#\\/people\\/(.+)$/,    handler: "pagePersonDetail" },
  { pattern: /^#\\/triage$/,          handler: "pageTriage" },
];
`;
