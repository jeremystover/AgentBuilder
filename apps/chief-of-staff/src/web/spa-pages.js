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
  const { showProject = true, projectsById = {}, onChanged, showTodayToggle = true } = opts;

  const priClassFor = (p) => {
    const pp = (p || "").toLowerCase();
    return pp === "high" ? "bg-rose-100 text-rose-700"
         : pp === "medium" ? "bg-amber-100 text-amber-800"
         : pp ? "bg-slate-100 text-slate-600"
         : "bg-slate-50 text-slate-400";
  };
  const PRI_BASE = "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border-0 cursor-pointer appearance-none focus:outline-none focus:ring-2 focus:ring-indigo-300";
  const projName = task.projectId && projectsById[task.projectId]
    ? projectsById[task.projectId].name : "";

  // Mutable state captured by closures so we can update the row in place
  // after a complete/star/save without re-rendering the whole page.
  // The server returns fresh state on the next route(); these in-DOM
  // updates only need to last until the user navigates away.
  let row;
  let todayState = !!task.today;

  const TODAY_BTN_ON  = "shrink-0 w-6 h-6 rounded-full text-sm leading-none transition flex items-center justify-center bg-amber-100 text-amber-600 ring-1 ring-amber-300 hover:bg-amber-200";
  const TODAY_BTN_OFF = "shrink-0 w-6 h-6 rounded-full text-sm leading-none transition flex items-center justify-center text-slate-300 hover:text-amber-500 hover:bg-amber-50";
  const ROW_ON  = "group flex items-center gap-3 py-2.5 px-3 -mx-3 rounded-lg bg-amber-50/60 hover:bg-amber-50 cursor-pointer";
  const ROW_OFF = "group flex items-center gap-3 py-2.5 px-3 -mx-3 rounded-lg hover:bg-slate-50 cursor-pointer";
  const DUE_BASE = "text-xs shrink-0";

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

  const checkbox = el("button", {
    class: "shrink-0 w-5 h-5 rounded-full border-2 border-slate-300 hover:border-emerald-500 transition flex items-center justify-center",
    title: "Mark complete",
    onclick: async (e) => {
      e.stopPropagation();
      // Optimistically dim the row — fire the API in the background
      // and restore on failure rather than triggering a full re-route.
      if (row) {
        row.style.transition = "opacity 200ms ease";
        row.style.pointerEvents = "none";
        row.style.opacity = "0.4";
      }
      try {
        await api(\`/api/tasks/\${encodeURIComponent(task.taskKey)}/complete\`, { method: "POST", body: {} });
        toast("Completed", "ok");
        animateRemove();
      } catch (err) {
        if (row) {
          row.style.opacity = "";
          row.style.pointerEvents = "";
        }
        toast(err.message, "err");
      }
    },
  });

  // Today toggle — pin a task to "do this today". Persists for the
  // calendar day and surfaces it at the top of /today and in Quick Wins.
  const todayBtn = showTodayToggle ? el("button", {
    class: todayState ? TODAY_BTN_ON : TODAY_BTN_OFF,
    title: todayState ? "Today task — click to remove" : "Mark as today task",
    onclick: async (e) => {
      e.stopPropagation();
      const next = !todayState;
      todayState = next;
      task.today = next;
      todayBtn.className = next ? TODAY_BTN_ON : TODAY_BTN_OFF;
      todayBtn.title = next ? "Today task — click to remove" : "Mark as today task";
      if (row) row.className = next ? ROW_ON : ROW_OFF;
      try {
        if (next) {
          await api("/api/today-tasks", { method: "POST", body: { taskKey: task.taskKey } });
          toast("Marked for today", "ok");
        } else {
          await api(\`/api/today-tasks/\${encodeURIComponent(task.taskKey)}\`, { method: "DELETE", body: {} });
          toast("Removed from today", "ok");
        }
      } catch (err) {
        todayState = !next;
        task.today = !next;
        todayBtn.className = todayState ? TODAY_BTN_ON : TODAY_BTN_OFF;
        todayBtn.title = todayState ? "Today task — click to remove" : "Mark as today task";
        if (row) row.className = todayState ? ROW_ON : ROW_OFF;
        toast(err.message, "err");
      }
    },
  }, "★") : null;

  // Inline priority dropdown — click to change without opening the editor.
  const priSel = el("select", {
    class: PRI_BASE + " " + priClassFor(task.priority),
    onclick: (e) => e.stopPropagation(),
    onchange: async (e) => {
      e.stopPropagation();
      const newPri = e.target.value;
      const prevPri = task.priority || "";
      task.priority = newPri;
      priSel.className = PRI_BASE + " " + priClassFor(newPri);
      try {
        await api(\`/api/tasks/\${encodeURIComponent(task.taskKey)}\`, {
          method: "PATCH", body: { patch: { priority: newPri } },
        });
        toast("Priority updated", "ok");
      } catch (err) {
        task.priority = prevPri;
        priSel.value = prevPri;
        priSel.className = PRI_BASE + " " + priClassFor(prevPri);
        toast(err.message, "err");
      }
    },
  });
  for (const [v, l] of [["", "— pri"], ["high", "HIGH"], ["medium", "MED"], ["low", "LOW"]]) {
    const o = el("option", { value: v }, l);
    if ((task.priority || "") === v) o.selected = true;
    priSel.appendChild(o);
  }

  const titleEl = el("div", { class: "text-sm text-ink truncate" }, task.title || "");
  const projEl = el("span", { class: "text-xs text-slate-500 truncate" }, projName);
  if (!(showProject && projName)) projEl.style.display = "none";
  const dueEl = el("span", { class: DUE_BASE }, "");
  function renderDue() {
    if (!task.dueAt) { dueEl.style.display = "none"; dueEl.textContent = ""; return; }
    dueEl.style.display = "";
    dueEl.textContent = fmtDate(task.dueAt);
    const overdue = isOverdue(task.dueAt);
    dueEl.className = DUE_BASE + (overdue ? " text-rose-600 font-medium" : " text-slate-500");
  }
  renderDue();

  // Editor callbacks — applied after a successful save/complete from the
  // edit modal so the row updates in place without a full re-render.
  function applySaved(updated) {
    Object.assign(task, updated);
    titleEl.textContent = task.title || "";
    priSel.value = task.priority || "";
    priSel.className = PRI_BASE + " " + priClassFor(task.priority);
    renderDue();
    if (showProject) {
      const name = task.projectId && projectsById[task.projectId]
        ? projectsById[task.projectId].name : "";
      projEl.textContent = name;
      projEl.style.display = name ? "" : "none";
    }
  }

  row = el("div", {
    class: todayState ? ROW_ON : ROW_OFF,
    onclick: () => openTaskEditor(task, {
      onSaved: applySaved,
      onCompleted: animateRemove,
      onChanged,
    }),
  },
    checkbox,
    todayBtn,
    el("div", { class: "flex-1 min-w-0" },
      titleEl,
      el("div", { class: "flex items-center gap-2 mt-0.5" }, priSel, projEl),
    ),
    dueEl,
  );
  return row;
}

function openTaskEditor(task, { onChanged, onSaved, onCompleted } = {}) {
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
            modal.close(); toast("Completed", "ok");
            // Prefer in-place row updates over a full re-render. Fall back
            // to onChanged for callers that don't supply onCompleted.
            if (onCompleted) onCompleted(); else onChanged?.();
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
            modal.close(); toast("Saved", "ok");
            if (onSaved) onSaved(patch); else onChanged?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Save"),
    ),
  );
  const modal = openModal(card);
}

// ── Brief editor (used on Today + This Week) ───────────────────────────────
function briefEditor({ kind, periodKey, brief, range }) {
  const wrap = el("div", { class: "bg-white rounded-2xl ring-1 ring-slate-200 p-5 space-y-3" });
  // Header label: range (e.g. "Apr 22 – Apr 28") preferred over the raw
  // ISO week key (2026-W17) — the raw key is opaque to humans.
  const label = range || periodKey;
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
  // ✨ Generate — fills the goals box with an AI-drafted starting brief
  // by hitting the existing day-plan / week-plan endpoint with no input.
  // The user can then edit. Generated content is also persisted to goalsMd
  // so a refresh keeps it.
  const genBtn = el("button", {
    class: "text-xs text-indigo-600 hover:underline",
    onclick: async () => {
      genBtn.disabled = true; genBtn.textContent = "Generating…";
      try {
        const data = await api("/api/" + kind + "-plan", {
          method: "POST",
          body: { input: "", periodKey, brief: { goalsMd: ta.value || "" } },
        });
        if (data.output) {
          ta.value = data.output;
          await api(\`/api/briefs/\${kind}/\${encodeURIComponent(periodKey)}\`, {
            method: "PUT", body: { goalsMd: ta.value },
          });
        }
        // Day plan may have pinned today tasks. The toast tells the user;
        // the Today section will pick them up next time it refreshes (the
        // show-completed toggle / plan review will refetch, otherwise the
        // pins surface on next navigation).
        if (kind === "day" && data?.todayTaskKeys?.length) {
          toast(\`Marked \${data.todayTaskKeys.length} task(s) for today\`, "ok");
        }
      } catch (err) { toast(err.message, "err"); }
      finally {
        genBtn.disabled = false; genBtn.textContent = "✨ Generate";
      }
    },
  }, "✨ Generate");
  wrap.appendChild(el("div", { class: "flex items-center justify-between" },
    el("div", { class: "flex items-baseline gap-3" },
      el("h3", { class: "text-base font-semibold" }, kind === "day" ? "Today's brief" : "Week brief"),
      el("span", { class: "text-xs text-slate-400" }, label),
    ),
    genBtn,
  ));
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
        if (action === "day-plan" && data?.todayTaskKeys?.length) {
          toast(\`Marked \${data.todayTaskKeys.length} task(s) for today\`, "ok");
        }
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
  const declinedNames = Array.isArray(m.declinedAttendees) ? m.declinedAttendees : [];
  const ringClass = m.anyDeclined
    ? "ring-2 ring-rose-300 hover:ring-rose-400"
    : "ring-1 ring-slate-200 hover:ring-indigo-300";
  const card = el("div", {
    class: \`bg-white rounded-xl \${ringClass} p-4 space-y-2 cursor-pointer transition\`,
    onclick: (e) => {
      if (e.target.closest("a")) return;
      openMeetingEditor(m, {
        onSaved: applyMeetingSaved,
        onChanged,
      });
    },
  });
  // Header: title + day/date/time — kept as refs so we can update in place.
  const titleEl = el("div", { class: "text-sm font-medium text-ink truncate" }, m.title || "(untitled)");
  const timeEl = el("div", { class: "text-xs text-slate-500 shrink-0" },
    [fmtDayDate(m.startTime), fmtTime(m.startTime) + " – " + fmtTime(m.endTime)]
      .filter(Boolean).join(" · "));
  card.appendChild(el("div", { class: "flex items-baseline justify-between gap-3" }, titleEl, timeEl));

  function applyMeetingSaved(patch) {
    Object.assign(m, patch);
    titleEl.textContent = m.title || "(untitled)";
    timeEl.textContent = [fmtDayDate(m.startTime), fmtTime(m.startTime) + " – " + fmtTime(m.endTime)]
      .filter(Boolean).join(" · ");
  }
  if (m.anyDeclined) {
    const who = declinedNames.length
      ? declinedNames.slice(0, 3).join(", ") + (declinedNames.length > 3 ? \` +\${declinedNames.length - 3}\` : "")
      : "An invitee";
    card.appendChild(el("div", { class: "text-xs font-medium text-rose-600" },
      \`⚠ \${who} declined — reschedule?\`));
  }
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

function openMeetingEditor(m, { onChanged, onSaved } = {}) {
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
            modal.close(); toast("Saved", "ok");
            if (onSaved) onSaved(body); else onChanged?.();
          } catch (err) { toast(err.message, "err"); }
        },
      }, "Save"),
    ),
  );
  const modal = openModal(card);
}

// ── Show-completed toggle (used by Today / Week / Project / Person) ───────
// Persists across navigations so the user doesn't have to re-enable it.
function showCompletedFlag(scope) {
  try { return localStorage.getItem("cos:showCompleted:" + scope) === "1"; }
  catch { return false; }
}
function setShowCompletedFlag(scope, v) {
  try { localStorage.setItem("cos:showCompleted:" + scope, v ? "1" : "0"); } catch {}
}
function showCompletedToggle(scope, onToggle) {
  const v = showCompletedFlag(scope);
  const btn = el("button", {
    class: \`text-xs px-3 py-1 rounded-full ring-1 transition \${v ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-white text-slate-500 ring-slate-200 hover:ring-indigo-300"}\`,
    onclick: () => { setShowCompletedFlag(scope, !v); onToggle(); },
  }, v ? "✓ Showing completed" : "Show completed");
  return btn;
}

// ── Page: Now ──────────────────────────────────────────────────────────────
// Right-this-minute focus view: countdown to the next meeting + prep, the
// previous meeting's transcript/summary entry point, a short list of quick
// wins, and the user-curated "Focus now" tray with a Release button.
function fmtCountdown(secs) {
  if (!Number.isFinite(secs) || secs <= 0) return "now";
  const m = Math.floor(secs / 60);
  if (m < 60) return m + "m " + String(secs % 60).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

let _nowTickHandle = null;

async function pageNow(main) {
  if (_nowTickHandle) { clearInterval(_nowTickHandle); _nowTickHandle = null; }
  const data = await api("/api/now");
  const projects = (await api("/api/projects")).projects || [];
  const projectsById = Object.fromEntries(projects.map((p) => [p.projectId, p]));
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-8" });
  root.appendChild(el("header", { class: "flex items-baseline justify-between gap-3" },
    el("h1", { class: "text-3xl font-semibold" }, "Now"),
    el("div", { class: "text-sm text-slate-500" },
      new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })),
  ));
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "Prep me for my next meeting",
    "What should I focus on for the next 30 minutes?",
    "Summarize my last meeting",
  ]));

  // ── Next meeting (with live countdown) ──
  const nextSec = el("section", { class: "bg-white rounded-2xl ring-1 ring-slate-200 p-5 space-y-3" });
  if (data.nextMeeting) {
    const m = data.nextMeeting;
    const head = el("div", { class: "flex items-baseline justify-between gap-3" },
      el("div", {},
        el("div", { class: "text-xs uppercase tracking-wide text-slate-400" },
          m.inProgress ? "In progress" : "Next meeting"),
        el("div", { class: "text-lg font-semibold mt-0.5" }, m.title || "(untitled)"),
      ),
      el("div", { class: "text-right" },
        el("div", { class: "text-2xl font-semibold text-indigo-600", id: "now-countdown" },
          m.inProgress ? "live" : fmtCountdown(m.secondsUntil)),
        el("div", { class: "text-xs text-slate-500" },
          fmtTime(m.startTime) + " – " + fmtTime(m.endTime)),
      ),
    );
    nextSec.appendChild(head);
    // Live tick — re-renders the countdown every second without re-fetching.
    if (!m.inProgress && Number.isFinite(m.secondsUntil)) {
      const startMs = Date.parse(m.startTime);
      _nowTickHandle = setInterval(() => {
        const node = document.getElementById("now-countdown");
        if (!node) return;
        const left = Math.max(0, Math.round((startMs - Date.now()) / 1000));
        node.textContent = left === 0 ? "now" : fmtCountdown(left);
      }, 1000);
    }
    const links = el("div", { class: "flex gap-3 flex-wrap text-xs" });
    if (m.htmlLink) links.appendChild(el("a", {
      href: m.htmlLink, target: "_blank", rel: "noopener",
      class: "text-indigo-600 hover:underline",
    }, "📅 Open invite"));
    if (m.zoomUrl) links.appendChild(el("a", {
      href: m.zoomUrl, target: "_blank", rel: "noopener",
      class: "text-indigo-600 hover:underline",
    }, "🎥 Join Zoom"));
    if (m.meetUrl) links.appendChild(el("a", {
      href: m.meetUrl, target: "_blank", rel: "noopener",
      class: "text-indigo-600 hover:underline",
    }, "🎥 Join Meet"));
    if (links.children.length) nextSec.appendChild(links);
    if (m.attendees?.length) {
      nextSec.appendChild(el("div", { class: "text-xs text-slate-500" },
        m.attendees.slice(0, 6).map((a) => a.name || a.email).filter(Boolean).join(", ")
          + (m.attendees.length > 6 ? \` +\${m.attendees.length - 6}\` : "")));
    }
    if (m.prep && (m.prep.projects?.length || m.prep.openTasks?.length || m.prep.openCommitments?.length || m.prep.stakeholders?.length)) {
      const prep = el("div", { class: "border-t border-slate-100 pt-3 space-y-1.5 text-xs" });
      if (m.prep.stakeholders?.length) prep.appendChild(el("div", {},
        el("span", { class: "uppercase tracking-wide text-slate-400 mr-2" }, "People"),
        m.prep.stakeholders.map((s) => s.name).join(", ")));
      if (m.prep.projects?.length) prep.appendChild(el("div", {},
        el("span", { class: "uppercase tracking-wide text-slate-400 mr-2" }, "Projects"),
        m.prep.projects.map((p) => p.name).join(", ")));
      if (m.prep.openTasks?.length) prep.appendChild(el("div", {},
        el("span", { class: "uppercase tracking-wide text-slate-400 mr-2" }, "Open tasks"),
        m.prep.openTasks.map((t) => t.title).join(" · ")));
      if (m.prep.openCommitments?.length) prep.appendChild(el("div", {},
        el("span", { class: "uppercase tracking-wide text-slate-400 mr-2" }, "Commitments"),
        m.prep.openCommitments.map((c) => c.description).join(" · ")));
      nextSec.appendChild(prep);
    }
  } else {
    nextSec.appendChild(el("div", { class: "text-sm text-slate-500" }, "No meetings on the calendar in the next 24 hours."));
  }
  root.appendChild(nextSec);

  // ── Recent meeting (transcript / summary entry point) ──
  if (data.recentMeeting) {
    root.appendChild(recentMeetingCard(data.recentMeeting));
  }

  // ── Focus now tray ──
  const focusSec = focusNowSection(data.focusTasks || [], data.quickWins || [], projectsById);
  root.appendChild(focusSec);

  // ── Quick wins ──
  if (data.quickWins?.length) {
    const sec = el("section", { class: "space-y-1" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Quick wins"));
    sec.appendChild(el("div", { class: "text-xs text-slate-500 mb-1" },
      "Small, prioritized things you could knock out right now."));
    for (const t of data.quickWins) {
      const focusBtn = el("button", {
        class: "shrink-0 px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100 text-xs",
        title: "Add to focus list",
        onclick: async () => {
          if (focusSec._inFocus(t.taskKey)) { toast("Already in focus", "info"); return; }
          focusBtn.disabled = true;
          try {
            await api("/api/focus-now", { method: "POST", body: { taskKey: t.taskKey } });
            toast("Added to focus", "ok");
            focusSec._addToFocus(t);
            focusBtn.textContent = "✓ In focus";
          } catch (err) {
            focusBtn.disabled = false;
            toast(err.message, "err");
          }
        },
      }, focusSec._inFocus(t.taskKey) ? "✓ In focus" : "+ Focus");
      if (focusSec._inFocus(t.taskKey)) focusBtn.disabled = true;
      const row = el("div", { class: "flex items-center gap-3 py-2" },
        focusBtn,
        el("div", { class: "flex-1" }, window.taskRow(t, { projectsById })),
      );
      sec.appendChild(row);
    }
    root.appendChild(sec);
  }

  main.appendChild(root);
}

function recentMeetingCard(m) {
  const sec = el("section", { class: "bg-white rounded-2xl ring-1 ring-slate-200 p-5 space-y-3" });
  sec.appendChild(el("div", { class: "flex items-baseline justify-between gap-3" },
    el("div", {},
      el("div", { class: "text-xs uppercase tracking-wide text-slate-400" }, "Just finished"),
      el("div", { class: "text-base font-semibold mt-0.5" }, m.title || "(untitled)"),
    ),
    el("div", { class: "text-xs text-slate-500" },
      fmtTime(m.startTime) + " – " + fmtTime(m.endTime)),
  ));

  const meetingId = m.meetingId || m.eventId || "";
  const status = el("div", { class: "text-xs text-slate-500" },
    m.hasTranscript ? "Transcript imported from Zoom." : "No transcript on file.");
  sec.appendChild(status);

  const transcriptBox = el("div", { class: "hidden bg-slate-50 rounded-lg p-3 text-xs whitespace-pre-wrap font-mono max-h-72 overflow-y-auto" });
  sec.appendChild(transcriptBox);

  const actions = el("div", { class: "flex flex-wrap gap-2" });
  if (m.hasTranscript) {
    actions.appendChild(el("button", {
      class: "text-xs px-3 py-1 rounded-full ring-1 ring-slate-200 hover:bg-slate-50",
      onclick: async () => {
        try {
          const r = await api("/api/meetings/" + encodeURIComponent(meetingId) + "/transcript");
          transcriptBox.textContent = r.transcript || "(empty)";
          transcriptBox.classList.remove("hidden");
        } catch (err) { toast(err.message, "err"); }
      },
    }, "Show transcript"));
  } else {
    actions.appendChild(el("button", {
      class: "text-xs px-3 py-1 rounded-full bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100",
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = "Importing…";
        try {
          const r = await api("/api/meetings/" + encodeURIComponent(meetingId) + "/transcript", {
            method: "POST", body: { daysBack: 1 },
          });
          if (r.transcript) {
            transcriptBox.textContent = r.transcript;
            transcriptBox.classList.remove("hidden");
            status.textContent = "Transcript imported from Zoom.";
            toast("Transcript imported", "ok");
          } else {
            toast(r.note || "No transcript yet — try again in a few minutes.", "info");
          }
        } catch (err) { toast(err.message, "err"); }
        finally { btn.disabled = false; btn.textContent = "Import from Zoom"; }
      },
    }, "Import from Zoom"));
  }
  sec.appendChild(actions);

  // Manual summary / transcript entry — saved as a Note(entityType=meeting).
  const ta = el("textarea", {
    rows: 4,
    class: "w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 text-sm focus:ring-indigo-400 focus:outline-none resize-none",
    placeholder: "Paste a transcript or jot a summary…",
  });
  ta.value = m.summary?.body || "";
  let saveTimer;
  ta.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api("/api/meetings/" + encodeURIComponent(meetingId) + "/summary", {
          method: "PUT", body: { body: ta.value },
        });
      } catch (err) { toast(err.message, "err"); }
    }, 600);
  });
  sec.appendChild(el("label", { class: "block text-xs uppercase tracking-wide text-slate-500" },
    "Your summary", ta));
  return sec;
}

function focusNowSection(focusTasks, quickWins, projectsById) {
  const sec = el("section", { class: "bg-amber-50 rounded-2xl ring-1 ring-amber-200 p-5 space-y-3" });
  // Pool of taskKeys currently in focus (for the picker to skip), and a
  // shared list-row container so we can append/remove without re-rendering.
  const focusKeys = new Set(focusTasks.map((t) => t.taskKey));
  const headerRow = el("div", { class: "flex items-baseline justify-between gap-3" });
  const releaseBtn = el("button", {
    class: "text-xs px-3 py-1 rounded-full bg-white ring-1 ring-amber-300 text-amber-800 hover:bg-amber-100",
    onclick: async () => {
      if (!confirm("Release the focus list?")) return;
      try {
        await api("/api/focus-now", { method: "DELETE", body: {} });
        toast("Released", "ok");
        focusKeys.clear();
        listEl.innerHTML = "";
        emptyMsg.style.display = "";
        releaseBtn.style.display = "none";
        rebuildPicker();
      } catch (err) { toast(err.message, "err"); }
    },
  }, "Release");
  if (!focusTasks.length) releaseBtn.style.display = "none";
  headerRow.append(el("h2", { class: "text-lg font-semibold" }, "Focus now"), releaseBtn);
  sec.appendChild(headerRow);

  const emptyMsg = el("div", { class: "text-sm text-slate-600" },
    "Pick a few tasks to focus on right now. Use the + Focus buttons below, or pick from the menu.");
  if (focusTasks.length) emptyMsg.style.display = "none";
  sec.appendChild(emptyMsg);

  const listEl = el("div", { class: "space-y-2" });
  sec.appendChild(listEl);

  function makeFocusRow(t) {
    const rowWrap = el("div", { class: "flex items-center gap-2 bg-white rounded-lg ring-1 ring-amber-200 px-2" });
    rowWrap.dataset.taskKey = t.taskKey;
    rowWrap.appendChild(el("div", { class: "flex-1" }, window.taskRow(t, { projectsById })));
    rowWrap.appendChild(el("button", {
      class: "text-xs text-slate-500 hover:text-rose-600 px-2",
      title: "Remove from focus",
      onclick: async () => {
        try {
          await api("/api/focus-now/" + encodeURIComponent(t.taskKey), { method: "DELETE", body: {} });
          rowWrap.remove();
          focusKeys.delete(t.taskKey);
          if (!focusKeys.size) {
            emptyMsg.style.display = "";
            releaseBtn.style.display = "none";
          }
          rebuildPicker();
        } catch (err) { toast(err.message, "err"); }
      },
    }, "✕"));
    return rowWrap;
  }

  for (const t of focusTasks) listEl.appendChild(makeFocusRow(t));

  // Picker — built/rebuilt to reflect what's already in focus.
  const pickerWrap = el("div", { class: "pt-2" });
  sec.appendChild(pickerWrap);
  const quickWinsByKey = new Map((quickWins || []).map((t) => [t.taskKey, t]));

  function rebuildPicker() {
    pickerWrap.innerHTML = "";
    const sel = el("select", { class: "w-full rounded-lg ring-1 ring-amber-200 bg-white px-3 py-2 text-sm" });
    sel.appendChild(el("option", { value: "" }, "+ Add a task to focus on…"));
    let pickable = 0;
    for (const t of quickWins || []) {
      if (focusKeys.has(t.taskKey)) continue;
      sel.appendChild(el("option", { value: t.taskKey }, t.title));
      pickable++;
    }
    if (!pickable) sel.disabled = true;
    sel.addEventListener("change", async () => {
      if (!sel.value) return;
      const taskKey = sel.value;
      const task = quickWinsByKey.get(taskKey);
      try {
        await api("/api/focus-now", { method: "POST", body: { taskKey } });
        toast("Added", "ok");
        if (task) addToFocus(task);
      } catch (err) { toast(err.message, "err"); }
    });
    pickerWrap.appendChild(sel);
  }
  rebuildPicker();

  function addToFocus(task) {
    if (focusKeys.has(task.taskKey)) return;
    focusKeys.add(task.taskKey);
    emptyMsg.style.display = "none";
    releaseBtn.style.display = "";
    listEl.appendChild(makeFocusRow(task));
    rebuildPicker();
  }

  // Expose so the Quick wins "+ Focus" buttons can promote without routing.
  sec._addToFocus = addToFocus;
  sec._inFocus = (taskKey) => focusKeys.has(taskKey);
  return sec;
}

function focusPicker() { /* deprecated — now built into focusNowSection */ return el("span"); }

// ── Page: Today ────────────────────────────────────────────────────────────
async function pageToday(main) {
  const initialIncludeCompleted = showCompletedFlag("today");
  const data = await api("/api/today" + (initialIncludeCompleted ? "?includeCompleted=1" : ""));
  const projects = (await api("/api/projects")).projects || [];
  const projectsById = Object.fromEntries(projects.map((p) => [p.projectId, p]));
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-8" });

  // Section refs used by onCreated below to drop newly-created task rows
  // into the page without a full re-render.
  const justAddedSec = el("section", { class: "space-y-1" });
  // Holds whichever task list the server returned + an emptyState placeholder.
  // Re-rendered in place when the show-completed toggle flips so the rest of
  // the page (brief, plan/review modals, meetings) keeps its DOM.
  const tasksHost = el("div", { class: "space-y-8" });

  function appendCreatedTask(newTask) {
    if (!justAddedSec.parentNode) {
      justAddedSec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Just added"));
      justAddedSec.appendChild(el("div", { class: "text-xs text-slate-500 mb-1" },
        "Created in this view. Refresh to see them merged with the rest of today's list."));
      tasksHost.parentNode.insertBefore(justAddedSec, tasksHost);
    }
    justAddedSec.appendChild(taskRow(newTask, { projectsById }));
    const emptyEl = tasksHost.querySelector("[data-empty-state]");
    if (emptyEl) emptyEl.remove();
  }

  function renderTasks(payload) {
    tasksHost.innerHTML = "";
    const todayPicks = (payload.tasks || []).filter((t) => t.today);
    const dueToday = (payload.tasks || []).filter((t) => !t.today);
    if (todayPicks.length) {
      const sec = el("section", { class: "space-y-1" });
      sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Today's tasks"));
      sec.appendChild(el("div", { class: "text-xs text-slate-500 mb-1" },
        "Tasks you've picked for today. They stay here until completed, removed, or the day ends."));
      for (const t of todayPicks) sec.appendChild(taskRow(t, { projectsById }));
      tasksHost.appendChild(sec);
    }
    if (dueToday.length) {
      const sec = el("section", { class: "space-y-1" });
      sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" },
        todayPicks.length ? "Also due today" : "Tasks"));
      if (!todayPicks.length) {
        sec.appendChild(el("div", { class: "text-xs text-slate-500 mb-1" },
          "Tap the ★ to pick a task for today."));
      }
      for (const t of dueToday) sec.appendChild(taskRow(t, { projectsById }));
      tasksHost.appendChild(sec);
    }
    if (!todayPicks.length && !dueToday.length) {
      tasksHost.appendChild(el("section", { class: "text-sm text-slate-500", "data-empty-state": "1" },
        "No tasks due today."));
    }
  }

  async function refreshTasks() {
    const includeCompleted = showCompletedFlag("today");
    try {
      const fresh = await api("/api/today" + (includeCompleted ? "?includeCompleted=1" : ""));
      renderTasks(fresh);
    } catch (err) { toast(err.message, "err"); }
  }

  root.appendChild(el("header", { class: "flex items-baseline justify-between gap-3" },
    el("h1", { class: "text-3xl font-semibold" }, new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })),
    el("div", { class: "flex items-center gap-3" },
      showCompletedToggle("today", refreshTasks),
      el("button", {
        class: "text-sm text-slate-500 hover:text-ink",
        onclick: () => openCreateTaskModal({ projectsById, onCreated: appendCreatedTask }),
      }, "+ New task"),
    ),
  ));

  root.appendChild(briefEditor({ kind: "day", periodKey: data.date, brief: data.brief }));
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "What's most important today?",
    "Reschedule anything I'll miss",
    "Draft my standup update",
  ]));
  root.appendChild(planReviewButtons({ kind: "day", periodKey: data.date, brief: data.brief, onDone: refreshTasks }));

  root.appendChild(tasksHost);
  renderTasks(data);

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
  const initialIncludeCompleted = showCompletedFlag("week");
  const data = await api("/api/week" + (initialIncludeCompleted ? "?includeCompleted=1" : ""));
  const projects = (await api("/api/projects")).projects || [];
  const projectsById = Object.fromEntries(projects.map((p) => [p.projectId, p]));
  main.innerHTML = "";
  const root = el("div", { class: "max-w-3xl mx-auto px-10 py-10 space-y-8" });
  const weekRange = data.from && data.to ? \`\${fmtDate(data.from)} – \${fmtDate(data.to)}\` : data.periodKey;

  const tasksHost = el("div", { class: "space-y-8" });
  function renderWeekTasks(payload) {
    tasksHost.innerHTML = "";
    if (payload.tasks?.length) {
      const sec = el("section", { class: "space-y-1" });
      sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Tasks"));
      for (const t of payload.tasks) sec.appendChild(taskRow(t, { projectsById }));
      tasksHost.appendChild(sec);
    }
  }
  async function refreshWeekTasks() {
    const includeCompleted = showCompletedFlag("week");
    try {
      const fresh = await api("/api/week" + (includeCompleted ? "?includeCompleted=1" : ""));
      renderWeekTasks(fresh);
    } catch (err) { toast(err.message, "err"); }
  }

  root.appendChild(el("header", { class: "flex items-baseline justify-between gap-3" },
    el("h1", { class: "text-3xl font-semibold" }, "This Week"),
    el("div", { class: "flex items-center gap-3" },
      showCompletedToggle("week", refreshWeekTasks),
      el("span", { class: "text-sm text-slate-500" }, weekRange),
    ),
  ));
  root.appendChild(briefEditor({ kind: "week", periodKey: data.periodKey, brief: data.brief, range: weekRange }));
  if (window.chatPromptBubbles) root.appendChild(window.chatPromptBubbles([
    "What are the themes for this week?",
    "Which projects are at risk?",
    "Who do I need to follow up with?",
  ]));
  root.appendChild(planReviewButtons({ kind: "week", periodKey: data.periodKey, brief: data.brief, onDone: refreshWeekTasks }));

  root.appendChild(tasksHost);
  renderWeekTasks(data);

  if (data.meetings?.length) {
    const sec = el("section", { class: "space-y-3" });
    sec.appendChild(el("h2", { class: "text-lg font-semibold mb-2" }, "Meetings"));
    for (const m of data.meetings) sec.appendChild(meetingCard(m));
    root.appendChild(sec);
  }

  main.appendChild(root);
}

window.pageNow   = pageNow;
window.pageToday = pageToday;
window.pageWeek  = pageWeek;
window.taskRow   = taskRow;
window.briefEditor = briefEditor;
window.planReviewButtons = planReviewButtons;
window.meetingCard = meetingCard;
window.openMeetingEditor = openMeetingEditor;
window.openTaskEditor = openTaskEditor;
window.openCreateTaskModal = openCreateTaskModal;
window.showCompletedFlag = showCompletedFlag;
window.setShowCompletedFlag = setShowCompletedFlag;
window.showCompletedToggle = showCompletedToggle;
`;
