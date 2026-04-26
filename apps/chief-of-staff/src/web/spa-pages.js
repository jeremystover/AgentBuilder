/**
 * web/spa-pages.js — chief-of-staff page renderers (Today + This Week)
 * and shared task/brief components.
 *
 * Concatenated into /app/app.js after @agentbuilder/web-ui-kit's
 * SPA_CORE_JS, which sets up window.__cos with shared helpers, the shell,
 * and the default chat sidebar.
 */

export const SPA_PAGES_JS = `
// $, el, fmtDate, fmtTime, isOverdue, api, toast, openModal, attachVoice
// are all declared at top level by spa-core (which is concatenated above
// this file at request time). No need to re-destructure from window.__cos.

// ── Task row (used on Today, This Week, Projects, People) ──────────────────
function taskRow(task, opts = {}) {
  const { showProject = true, projectsById = {}, onChanged } = opts;
  const pri = (task.priority || "").toLowerCase();
  const priColor = pri === "high" ? "bg-rose-100 text-rose-700"
                 : pri === "medium" ? "bg-amber-100 text-amber-800"
                 : pri ? "bg-slate-100 text-slate-600"
                 : "";
  const due = task.dueAt ? fmtDate(task.dueAt) : "";
  const overdue = isOverdue(task.dueAt);
  const projName = task.projectId && projectsById[task.projectId]
    ? projectsById[task.projectId].name : "";

  const checkbox = el("button", {
    class: "shrink-0 w-5 h-5 rounded-full border-2 border-slate-300 hover:border-emerald-500 transition flex items-center justify-center",
    title: "Mark complete",
    onclick: async (e) => {
      e.stopPropagation();
      try {
        await api(\`/api/tasks/\${encodeURIComponent(task.taskKey)}/complete\`, { method: "POST", body: {} });
        toast("Completed", "ok");
        onChanged?.();
      } catch (err) { toast(err.message, "err"); }
    },
  });

  const row = el("div", {
    class: "group flex items-center gap-3 py-2.5 px-3 -mx-3 rounded-lg hover:bg-slate-50 cursor-pointer",
    onclick: () => openTaskEditor(task, { onChanged }),
  },
    checkbox,
    el("div", { class: "flex-1 min-w-0" },
      el("div", { class: "text-sm text-ink truncate" }, task.title),
      (showProject && projName) || pri ? el("div", { class: "flex items-center gap-2 mt-0.5" },
        pri ? el("span", { class: \`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded \${priColor}\` }, pri) : null,
        showProject && projName ? el("span", { class: "text-xs text-slate-500 truncate" }, projName) : null,
      ) : null,
    ),
    due ? el("span", {
      class: \`text-xs \${overdue ? "text-rose-600 font-medium" : "text-slate-500"} shrink-0\`,
    }, due) : null,
  );
  return row;
}

function openTaskEditor(task, { onChanged } = {}) {
  const titleI = el("input", {
    type: "text", value: task.title || "",
    class: "w-full text-lg font-medium rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none",
  });
  const dueI = el("input", {
    type: "date", value: (task.dueAt || "").slice(0, 10),
    class: "rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none",
  });
  const priI = el("select", {
    class: "rounded-lg ring-1 ring-slate-200 px-3 py-2 bg-white focus:ring-indigo-400 focus:outline-none",
  });
  for (const p of [["", "—"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]) {
    const o = el("option", { value: p[0] }, p[1]);
    if ((task.priority || "") === p[0]) o.selected = true;
    priI.appendChild(o);
  }
  const notesI = el("textarea", {
    rows: 5,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: "Notes…",
  });
  notesI.value = task.notes || "";

  const card = el("div", { class: "space-y-4" },
    el("h2", { class: "text-xl font-semibold" }, "Edit task"),
    titleI,
    el("div", { class: "flex gap-3" },
      el("label", { class: "flex-1 text-xs uppercase tracking-wide text-slate-500" }, "Due", dueI),
      el("label", { class: "flex-1 text-xs uppercase tracking-wide text-slate-500" }, "Priority", priI),
    ),
    el("label", { class: "block text-xs uppercase tracking-wide text-slate-500" }, "Notes", notesI),
    el("div", { class: "flex justify-between pt-2" },
      el("button", {
        class: "text-sm text-rose-600 hover:underline",
        onclick: async () => {
          if (!confirm("Mark task as done?")) return;
          try {
            await api(\`/api/tasks/\${encodeURIComponent(task.taskKey)}/complete\`, { method: "POST", body: {} });
            modal.close(); toast("Completed", "ok"); onChanged?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Mark complete"),
      el("button", {
        class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
        onclick: async () => {
          const patch = {
            title: titleI.value.trim(),
            dueAt: dueI.value ? new Date(dueI.value).toISOString() : "",
            priority: priI.value,
            notes: notesI.value,
          };
          try {
            await api(\`/api/tasks/\${encodeURIComponent(task.taskKey)}\`, { method: "PATCH", body: { patch } });
            modal.close(); toast("Saved", "ok"); onChanged?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Save"),
    ),
  );
  const modal = openModal(card);
}

// ── Brief editor (used on Today + This Week) ───────────────────────────────
function briefEditor({ kind, periodKey, brief }) {
  const wrap = el("div", { class: "bg-white rounded-2xl ring-1 ring-slate-200 p-5 space-y-3" });
  wrap.appendChild(el("div", { class: "flex items-center justify-between" },
    el("h3", { class: "text-base font-semibold" }, kind === "day" ? "Today's brief" : "Week brief"),
    el("span", { class: "text-xs text-slate-400" }, periodKey),
  ));
  const ta = el("textarea", {
    rows: 5,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: kind === "day" ? "Goals for today…" : "Goals for this week…",
  });
  ta.value = brief?.goalsMd || "";
  let saveTimer;
  ta.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api(\`/api/briefs/\${kind}/\${encodeURIComponent(periodKey)}\`, {
          method: "PUT", body: { goalsMd: ta.value },
        });
      } catch (err) { toast(err.message, "err"); }
    }, 600);
  });
  wrap.appendChild(ta);
  if (brief?.generatedMd) {
    wrap.appendChild(el("details", { class: "text-sm text-slate-600" },
      el("summary", { class: "cursor-pointer text-xs uppercase tracking-wide text-slate-500" }, "Last plan"),
      el("pre", { class: "mt-2 whitespace-pre-wrap font-sans text-sm" }, brief.generatedMd),
    ));
  }
  if (brief?.reviewMd) {
    wrap.appendChild(el("details", { class: "text-sm text-slate-600" },
      el("summary", { class: "cursor-pointer text-xs uppercase tracking-wide text-slate-500" }, "Last review"),
      el("pre", { class: "mt-2 whitespace-pre-wrap font-sans text-sm" }, brief.reviewMd),
    ));
  }
  return wrap;
}

function planReviewButtons({ kind, periodKey, brief, onDone }) {
  const wrap = el("div", { class: "flex gap-3" });
  const mkBtn = (label, action) => el("button", {
    class: "flex-1 rounded-xl bg-white ring-1 ring-slate-200 hover:ring-indigo-400 px-4 py-3 text-sm font-medium text-ink transition",
    onclick: () => openPlanReviewModal({ kind, action, periodKey, brief, onDone }),
  }, label);
  wrap.appendChild(mkBtn(kind === "day" ? "Day plan" : "Week plan",   kind + "-plan"));
  wrap.appendChild(mkBtn(kind === "day" ? "Day review" : "Week review", kind + "-review"));
  return wrap;
}

function openPlanReviewModal({ kind, action, periodKey, brief, onDone }) {
  const ta = el("textarea", {
    rows: 8,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: action.endsWith("plan")
      ? "What's on your mind for the period? Type or hit 🎤 to speak."
      : "How did it go? What slipped? Type or speak.",
  });
  const voiceBtn = el("button", {
    class: "rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm hover:bg-slate-50",
  }, "🎤");
  attachVoice(voiceBtn, ta);
  const out = el("div", { class: "hidden bg-slate-50 rounded-lg p-4 text-sm whitespace-pre-wrap font-sans" });
  const submit = el("button", {
    class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
    onclick: async () => {
      submit.disabled = true; submit.textContent = "Working…";
      try {
        const data = await api("/api/" + action, {
          method: "POST",
          body: { input: ta.value, periodKey, brief: { goalsMd: brief?.goalsMd || "" } },
        });
        out.textContent = data.output || "(no output)";
        out.classList.remove("hidden");
        onDone?.();
      } catch (err) {
        out.textContent = "Error: " + err.message;
        out.classList.remove("hidden");
      } finally {
        submit.disabled = false;
        submit.textContent = action.endsWith("plan") ? "Plan it" : "Review it";
      }
    },
  }, action.endsWith("plan") ? "Plan it" : "Review it");

  const card = el("div", { class: "space-y-4 w-full" },
    el("h2", { class: "text-xl font-semibold" },
      (kind === "day" ? "Day " : "Week ") + (action.endsWith("plan") ? "plan" : "review")),
    el("div", { class: "flex gap-2 items-start" }, ta, voiceBtn),
    out,
    el("div", { class: "flex justify-end" }, submit),
  );
  openModal(card);
}

// ── Calendar list (used on Today + This Week + Project/Person detail) ─────
function fmtDayDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return \`\${d.getFullYear()}-\${pad(d.getMonth()+1)}-\${pad(d.getDate())}T\${pad(d.getHours())}:\${pad(d.getMinutes())}\`;
}

function meetingCard(m, opts = {}) {
  const { onChanged } = opts;
  const card = el("div", {
    class: "bg-white rounded-xl ring-1 ring-slate-200 hover:ring-indigo-300 p-4 space-y-2 cursor-pointer transition",
    onclick: (e) => {
      // Don't open editor when the user clicks a real link inside the card.
      if (e.target.closest("a")) return;
      openMeetingEditor(m, { onChanged: onChanged || (() => window.__cos.route()) });
    },
  });
  // Header: title + day/date/time
  card.appendChild(el("div", { class: "flex items-baseline justify-between gap-3" },
    el("div", { class: "text-sm font-medium text-ink truncate" }, m.title || "(untitled)"),
    el("div", { class: "text-xs text-slate-500 shrink-0" },
      [fmtDayDate(m.startTime), fmtTime(m.startTime) + " – " + fmtTime(m.endTime)]
        .filter(Boolean).join(" · ")),
  ));
  // Link row: calendar invite + zoom/meet
  const links = [];
  if (m.htmlLink) {
    links.push(el("a", {
      href: m.htmlLink, target: "_blank", rel: "noopener",
      class: "text-xs text-indigo-600 hover:underline inline-flex items-center gap-1",
      onclick: (e) => e.stopPropagation(),
    }, "📅 Open invite"));
  }
  if (m.zoomUrl) {
    links.push(el("a", {
      href: m.zoomUrl, target: "_blank", rel: "noopener",
      class: "text-xs text-indigo-600 hover:underline inline-flex items-center gap-1",
      onclick: (e) => e.stopPropagation(),
    }, "🎥 Join Zoom"));
  } else if (m.meetUrl) {
    links.push(el("a", {
      href: m.meetUrl, target: "_blank", rel: "noopener",
      class: "text-xs text-indigo-600 hover:underline inline-flex items-center gap-1",
      onclick: (e) => e.stopPropagation(),
    }, "🎥 Join Meet"));
  }
  if (links.length) card.appendChild(el("div", { class: "flex gap-3 flex-wrap" }, ...links));
  if (m.attendees?.length) {
    card.appendChild(el("div", { class: "text-xs text-slate-500" },
      m.attendees.slice(0, 5).map((a) => a.name || a.email).filter(Boolean).join(", ")
        + (m.attendees.length > 5 ? \` +\${m.attendees.length - 5}\` : "")));
  }
  if (m.prep && (m.prep.stakeholders?.length || m.prep.projects?.length || m.prep.openTasks?.length || m.prep.openCommitments?.length)) {
    const prep = el("div", { class: "border-t border-slate-100 pt-2 mt-2 space-y-1 text-xs" });
    if (m.prep.projects?.length) prep.appendChild(el("div", {},
      el("span", { class: "uppercase tracking-wide text-slate-400 mr-2" }, "Projects"),
      m.prep.projects.map((p) => p.name).join(", ")));
    if (m.prep.openTasks?.length) prep.appendChild(el("div", {},
      el("span", { class: "uppercase tracking-wide text-slate-400 mr-2" }, "Open tasks"),
      m.prep.openTasks.map((t) => t.title).join(" · ")));
    if (m.prep.openCommitments?.length) prep.appendChild(el("div", {},
      el("span", { class: "uppercase tracking-wide text-slate-400 mr-2" }, "Commitments"),
      m.prep.openCommitments.map((c) => c.description).join(" · ")));
    card.appendChild(prep);
  }
  return card;
}

function openMeetingEditor(m, { onChanged } = {}) {
  if (!m.eventId) {
    toast("Missing eventId — can't edit this meeting", "err");
    return;
  }
  const titleI = el("input", {
    type: "text", value: m.title || "",
    class: "w-full text-lg font-medium rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none",
  });
  const startI = el("input", {
    type: "datetime-local", value: isoToLocalInput(m.startTime),
    class: "rounded-lg ring-1 ring-slate-200 px-3 py-2",
  });
  const endI = el("input", {
    type: "datetime-local", value: isoToLocalInput(m.endTime),
    class: "rounded-lg ring-1 ring-slate-200 px-3 py-2",
  });
  const descI = el("textarea", {
    rows: 5,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: "Description / agenda…",
  });
  descI.value = m.description || "";
  const locI = el("input", {
    type: "text", value: m.location || "",
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm",
    placeholder: "Location / Zoom URL",
  });
  const attendees = el("div", { class: "text-xs text-slate-500" },
    m.attendees?.length
      ? "Attendees: " + m.attendees.map((a) => a.name || a.email).filter(Boolean).join(", ")
      : "No attendees on file.");
  const links = el("div", { class: "flex gap-3 text-xs" });
  if (m.htmlLink) links.appendChild(el("a", {
    href: m.htmlLink, target: "_blank", rel: "noopener",
    class: "text-indigo-600 hover:underline",
  }, "Open in Google Calendar ↗"));
  if (m.zoomUrl) links.appendChild(el("a", {
    href: m.zoomUrl, target: "_blank", rel: "noopener",
    class: "text-indigo-600 hover:underline",
  }, "Join Zoom ↗"));

  const card = el("div", { class: "space-y-4" },
    el("h2", { class: "text-xl font-semibold" }, "Edit meeting"),
    titleI,
    el("div", { class: "grid grid-cols-2 gap-3" },
      el("label", { class: "text-xs uppercase tracking-wide text-slate-500" }, "Start", startI),
      el("label", { class: "text-xs uppercase tracking-wide text-slate-500" }, "End", endI),
    ),
    el("label", { class: "block text-xs uppercase tracking-wide text-slate-500" }, "Location", locI),
    el("label", { class: "block text-xs uppercase tracking-wide text-slate-500" }, "Description", descI),
    attendees,
    links,
    el("div", { class: "flex justify-end pt-2" },
      el("button", {
        class: "rounded-lg bg-ink text-white px-4 py-2 text-sm font-medium hover:bg-slate-700",
        onclick: async () => {
          try {
            const body = {
              title: titleI.value,
              startTime: startI.value ? new Date(startI.value).toISOString() : undefined,
              endTime: endI.value ? new Date(endI.value).toISOString() : undefined,
              description: descI.value,
              location: locI.value,
            };
            await api(\`/api/calendar/\${encodeURIComponent(m.eventId)}\`, { method: "PATCH", body });
            modal.close(); toast("Saved", "ok"); onChanged?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Save"),
    ),
  );
  const modal = openModal(card);
}

// ── Page: Today ────────────────────────────────────────────────────────────
async function pageToday(main) {
  const data = await api("/api/today");
  const projects = (await api("/api/projects")).projects || [];
  const projectsById = Object.fromEntries(projects.map((p) => [p.projectId, p]));
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-8" });
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })),
    el("button", {
      class: "text-sm text-slate-500 hover:text-ink",
      onclick: () => openCreateTaskModal({ projectsById, onChanged: () => window.__cos.route() }),
    }, "+ New task"),
  ));

  root.appendChild(briefEditor({ kind: "day", periodKey: data.date, brief: data.brief }));
  root.appendChild(planReviewButtons({ kind: "day", periodKey: data.date, brief: data.brief, onDone: () => window.__cos.route() }));

  if (data.tasks?.length) {
    const sec = el("section", { class: "space-y-1" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Tasks"));
    for (const t of data.tasks) sec.appendChild(taskRow(t, { projectsById, onChanged: () => window.__cos.route() }));
    root.appendChild(sec);
  } else {
    root.appendChild(el("section", { class: "text-sm text-slate-500" }, "No tasks due today."));
  }

  if (data.meetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Meetings"));
    for (const m of data.meetings) sec.appendChild(meetingCard(m));
    root.appendChild(sec);
  }

  main.appendChild(root);
}

// ── Page: This Week ────────────────────────────────────────────────────────
async function pageWeek(main) {
  const data = await api("/api/week");
  const projects = (await api("/api/projects")).projects || [];
  const projectsById = Object.fromEntries(projects.map((p) => [p.projectId, p]));
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-8" });
  root.appendChild(el("header", { class: "flex items-baseline justify-between" },
    el("h1", { class: "text-3xl font-semibold" }, "This Week"),
    el("span", { class: "text-sm text-slate-500" }, data.periodKey),
  ));
  root.appendChild(briefEditor({ kind: "week", periodKey: data.periodKey, brief: data.brief }));
  root.appendChild(planReviewButtons({ kind: "week", periodKey: data.periodKey, brief: data.brief, onDone: () => window.__cos.route() }));

  if (data.tasks?.length) {
    const sec = el("section", { class: "space-y-1" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Tasks"));
    for (const t of data.tasks) sec.appendChild(taskRow(t, { projectsById, onChanged: () => window.__cos.route() }));
    root.appendChild(sec);
  }

  if (data.meetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Meetings"));
    for (const m of data.meetings) sec.appendChild(meetingCard(m));
    root.appendChild(sec);
  }

  main.appendChild(root);
}

window.pageToday = pageToday;
window.pageWeek  = pageWeek;
window.taskRow   = taskRow;
window.briefEditor = briefEditor;
window.planReviewButtons = planReviewButtons;
window.meetingCard = meetingCard;
window.openMeetingEditor = openMeetingEditor;
window.openTaskEditor = openTaskEditor;
window.openCreateTaskModal = openCreateTaskModal;
`;
