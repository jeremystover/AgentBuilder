/**
 * crm.js — Phase 2 CRM tools: stakeholder + project 360 views.
 *
 * Factory: createCrmTools({ spreadsheetId, sheets }) returns the tools object.
 * Works in Cloudflare Workers (no Node.js dependencies).
 */

// ── Relationship health score ────────────────────────────────────────────────
// 4 = touched this week
// 3 = within cadenceDays
// 2 = within 1.5 × cadenceDays
// 1 = within 2 × cadenceDays
// 0 = beyond 2 × cadenceDays (overdue for touch)

function computeRelationshipHealth(lastInteractionAt, cadenceDays) {
  if (!lastInteractionAt) return 0;
  const cadence = Number(cadenceDays) || 14;
  const daysSince = Math.round((Date.now() - new Date(lastInteractionAt).getTime()) / 86400000);
  if (daysSince <= 7) return 4;
  if (daysSince <= cadence) return 3;
  if (daysSince <= cadence * 1.5) return 2;
  if (daysSince <= cadence * 2) return 1;
  return 0;
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  return Math.round((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

function formatContent(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function parseJson(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return []; }
}

/**
 * createCrmTools({ spreadsheetId, sheets }) — CRM tool registry.
 */
export function createCrmTools({ spreadsheetId, sheets }) {
  const { readSheetAsObjects } = sheets;

  // ── get_stakeholder_360 ─────────────────────────────────────────────────
  async function runStakeholder360(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

    const query = String(args.personId || "").toLowerCase().trim();
    if (!query) return formatContent({ error: "personId is required (email or name)" });

    try {
      const [stakeholders, meetings, commitments, tasks, intake, goals, projects] = await Promise.all([
        readSheetAsObjects("Stakeholders").catch(() => []),
        readSheetAsObjects("Meetings").catch(() => []),
        readSheetAsObjects("Commitments").catch(() => []),
        readSheetAsObjects("Tasks").catch(() => []),
        readSheetAsObjects("IntakeQueue").catch(() => []),
        readSheetAsObjects("Goals").catch(() => []),
        readSheetAsObjects("Projects").catch(() => []),
      ]);

      // Find the stakeholder by email or name
      const person = stakeholders.find((s) =>
        String(s.email || "").toLowerCase() === query ||
        String(s.stakeholderId || "").toLowerCase() === query ||
        String(s.name || "").toLowerCase().includes(query)
      );

      if (!person) {
        return formatContent({
          error: `Stakeholder not found: ${args.personId}`,
          hint: "Try a partial name or exact email. Run list_stakeholders_needing_touch to see all known stakeholders."
        });
      }

      const email = String(person.email || "").toLowerCase();
      const stakeholderId = String(person.stakeholderId || "");

      // Relationship health
      const health = computeRelationshipHealth(person.lastInteractionAt, person.cadenceDays);
      const touchedDaysAgo = daysSince(person.lastInteractionAt);

      // Last N meetings (match on attendeesJson containing their email)
      const personMeetings = meetings
        .filter((m) => {
          const attendees = String(m.attendeesJson || "").toLowerCase();
          return email && attendees.includes(email);
        })
        .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))
        .slice(0, 5)
        .map((m) => ({
          meetingId: m.meetingId,
          title: m.title,
          startTime: m.startTime,
          transcriptRef: m.transcriptRef || null,
          actionItemsExtracted: m.actionItemsExtracted || null,
        }));

      // Active commitments — theirs to me
      const theirCommitments = commitments.filter((c) =>
        String(c.ownerType) === "other" &&
        (String(c.ownerId || "").toLowerCase().includes(query) ||
          String(c.stakeholderId || "").toLowerCase() === stakeholderId)
      ).filter((c) => !["done", "dropped"].includes(String(c.status || "").toLowerCase()))
        .map((c) => ({
          commitmentId: c.commitmentId,
          description: c.description,
          dueAt: c.dueAt,
          overdue: !!(c.dueAt && new Date(c.dueAt) < new Date()),
          sourceType: c.sourceType,
          sourceRef: c.sourceRef,
        }));

      // My commitments to them
      const myCommitments = commitments.filter((c) =>
        String(c.ownerType) === "me" &&
        (String(c.ownerId || "").toLowerCase().includes(query) ||
          String(c.stakeholderId || "").toLowerCase() === stakeholderId)
      ).filter((c) => !["done", "dropped"].includes(String(c.status || "").toLowerCase()))
        .map((c) => ({
          commitmentId: c.commitmentId,
          description: c.description,
          dueAt: c.dueAt,
          overdue: !!(c.dueAt && new Date(c.dueAt) < new Date()),
          sourceType: c.sourceType,
          sourceRef: c.sourceRef,
        }));

      // Open tasks connected to this person
      const openTasks = tasks.filter((t) => {
        const status = String(t.status || "").toLowerCase();
        if (!(!status || status === "open" || status === "in_progress" || status === "pending")) return false;
        return String(t.ownerId || "").toLowerCase().includes(query);
      }).slice(0, 10).map((t) => ({
        taskKey: t.taskKey,
        title: t.title || t.subject,
        dueAt: t.dueAt,
        priority: t.priority,
      }));

      // Recent intake items mentioning them
      const recentIntake = intake.filter((i) => {
        const payload = String(i.payloadJson || "") + String(i.summary || "");
        return payload.toLowerCase().includes(query);
      })
        .filter((i) => String(i.status) === "pending")
        .slice(0, 5)
        .map((i) => ({ intakeId: i.intakeId, kind: i.kind, summary: i.summary, createdAt: i.createdAt }));

      // Goals + projects this stakeholder is linked to via stakeholdersJson.
      // Goals are the anchor — if the user is walking into a 1:1 they want
      // to see "what outcomes does this person touch" before scanning tasks.
      const linkedGoals = goals
        .filter((g) => parseJson(g.stakeholdersJson).map(String).includes(stakeholderId))
        .map((g) => ({
          goalId: g.goalId,
          title: g.title,
          quarter: g.quarter,
          status: g.status,
          priority: g.priority,
          targetDate: g.targetDate,
        }));

      const linkedProjects = projects
        .filter((p) => parseJson(p.stakeholdersJson).map(String).includes(stakeholderId))
        .map((p) => ({
          projectId: p.projectId,
          name: p.name,
          goalId: p.goalId,
          status: p.status,
          healthStatus: p.healthStatus,
          nextMilestoneAt: p.nextMilestoneAt,
        }));

      return formatContent({
        stakeholderId,
        name: person.name,
        email: person.email,
        tierTag: person.tierTag || "",
        cadenceDays: Number(person.cadenceDays) || 14,
        relationshipHealth: health,
        relationshipHealthLabel: ["dead", "overdue", "fading", "ok", "strong"][health],
        lastInteractionAt: person.lastInteractionAt || null,
        daysSinceLastTouch: touchedDaysAgo,
        goals: linkedGoals,
        projects: linkedProjects,
        recentMeetings: personMeetings,
        myCommitmentsToThem: myCommitments,
        theirCommitmentsToMe: theirCommitments,
        openTasks,
        pendingIntakeMentions: recentIntake,
        actions: [
          theirCommitments.filter((c) => c.overdue).length > 0
            ? `⚠️ ${theirCommitments.filter((c) => c.overdue).length} overdue commitment(s) from them — consider following up.`
            : null,
          myCommitments.filter((c) => c.overdue).length > 0
            ? `🔴 ${myCommitments.filter((c) => c.overdue).length} overdue commitment(s) you owe them.`
            : null,
          health <= 1
            ? `📅 Relationship health is ${health}/4 — you're past your ${Number(person.cadenceDays) || 14}-day touch cadence.`
            : null,
        ].filter(Boolean),
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  // ── get_project_360 ─────────────────────────────────────────────────────
  async function runProject360(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

    const query = String(args.projectId || "").toLowerCase().trim();
    if (!query) return formatContent({ error: "projectId is required" });

    try {
      const [projects, tasks, commitments, meetings, goals] = await Promise.all([
        readSheetAsObjects("Projects").catch(() => []),
        readSheetAsObjects("Tasks").catch(() => []),
        readSheetAsObjects("Commitments").catch(() => []),
        readSheetAsObjects("Meetings").catch(() => []),
        readSheetAsObjects("Goals").catch(() => []),
      ]);

      // Match the list endpoint's behaviour: if the same projectId has
      // multiple rows, the latest one wins. findLast keeps detail and list
      // in sync — otherwise the list (which dedupes to the last row) can
      // show a project whose detail page 404s on an earlier deleted row.
      const project = projects.findLast((p) =>
        String(p.projectId || "").toLowerCase() === query ||
        String(p.name || "").toLowerCase().includes(query)
      );

      if (!project) {
        return formatContent({ error: `Project not found: ${args.projectId}` });
      }

      const projectId = String(project.projectId || "");

      const openTasks = tasks
        .filter((t) => {
          const status = String(t.status || "").toLowerCase();
          if (!(!status || status === "open" || status === "in_progress" || status === "pending")) return false;
          return String(t.projectId || "").toLowerCase() === projectId;
        })
        .sort((a, b) => {
          if (a.dueAt && b.dueAt) return String(a.dueAt).localeCompare(String(b.dueAt));
          return a.dueAt ? -1 : 1;
        })
        .slice(0, 15)
        .map((t) => ({
          taskKey: t.taskKey,
          title: t.title || t.subject,
          status: t.status,
          priority: t.priority,
          dueAt: t.dueAt,
          overdue: !!(t.dueAt && new Date(t.dueAt) < new Date()),
        }));

      const openCommitments = commitments
        .filter((c) => String(c.projectId || "").toLowerCase() === projectId)
        .filter((c) => !["done", "dropped"].includes(String(c.status || "").toLowerCase()))
        .map((c) => ({
          commitmentId: c.commitmentId,
          ownerType: c.ownerType,
          ownerId: c.ownerId,
          description: c.description,
          dueAt: c.dueAt,
          overdue: !!(c.dueAt && new Date(c.dueAt) < new Date()),
        }));

      const recentMeetings = meetings
        .filter((m) => {
          const raw = String(m.rawJson || "").toLowerCase();
          return raw.includes(projectId) || String(m.title || "").toLowerCase().includes(query);
        })
        .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))
        .slice(0, 5)
        .map((m) => ({ meetingId: m.meetingId, title: m.title, startTime: m.startTime }));

      const parentGoal = project.goalId
        ? (goals.find((g) => String(g.goalId) === String(project.goalId)) || null)
        : null;

      return formatContent({
        projectId,
        name: project.name,
        status: project.status,
        priority: project.priority,
        healthStatus: project.healthStatus || "",
        nextMilestoneAt: project.nextMilestoneAt || null,
        lastTouchedAt: project.lastTouchedAt || null,
        daysSinceLastTouch: daysSince(project.lastTouchedAt),
        goal: parentGoal
          ? { goalId: parentGoal.goalId, title: parentGoal.title, quarter: parentGoal.quarter, status: parentGoal.status }
          : null,
        stakeholders: parseJson(project.stakeholdersJson).slice(0, 10),
        openTasks,
        openCommitments,
        recentMeetings,
        overdueTasks: openTasks.filter((t) => t.overdue).length,
        overdueCommitments: openCommitments.filter((c) => c.overdue).length,
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  // ── list_stakeholders_needing_touch ──────────────────────────────────────
  async function runListStakeholdersNeedingTouch(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

    try {
      const stakeholders = await readSheetAsObjects("Stakeholders").catch(() => []);
      const tierFilter = args.tier ? String(args.tier).toLowerCase() : null;
      const maxHealth = args.maxHealth !== undefined ? Number(args.maxHealth) : 2;

      const results = stakeholders
        .map((s) => {
          const health = computeRelationshipHealth(s.lastInteractionAt, s.cadenceDays);
          return {
            stakeholderId: s.stakeholderId,
            name: s.name,
            email: s.email,
            tierTag: s.tierTag || "",
            cadenceDays: Number(s.cadenceDays) || 14,
            lastInteractionAt: s.lastInteractionAt || null,
            daysSinceLastTouch: daysSince(s.lastInteractionAt),
            relationshipHealth: health,
            relationshipHealthLabel: ["dead", "overdue", "fading", "ok", "strong"][health],
          };
        })
        .filter((s) => s.relationshipHealth <= maxHealth)
        .filter((s) => !tierFilter || s.tierTag.toLowerCase() === tierFilter)
        .sort((a, b) => a.relationshipHealth - b.relationshipHealth || (b.daysSinceLastTouch || 0) - (a.daysSinceLastTouch || 0));

      return formatContent({
        count: results.length,
        maxHealth,
        stakeholders: results.slice(0, args.limit || 20),
        note: "Call get_stakeholder_360({personId}) for full context on any of these.",
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  return {
    get_stakeholder_360: {
      description:
        "Return a full 360° view of a stakeholder: profile, relationship health, recent meetings, " +
        "commitments (mine to them + theirs to me), open tasks, and pending intake mentions. " +
        "Use before a meeting, after a 1:1, or when asked 'how are things with <person>?'.",
      inputSchema: {
        type: "object",
        properties: {
          personId: {
            type: "string",
            description: "Email address, stakeholderId, or partial name to look up.",
          },
        },
        required: ["personId"],
        additionalProperties: false,
      },
      run: runStakeholder360,
    },

    get_project_360: {
      description:
        "Return a full 360° view of a project: status, health, open tasks, commitments, " +
        "recent meetings, and stakeholders. Use for project reviews or catch-ups.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "projectId or partial project name.",
          },
        },
        required: ["projectId"],
        additionalProperties: false,
      },
      run: runProject360,
    },

    list_stakeholders_needing_touch: {
      description:
        "List stakeholders who are past their touch cadence or have low relationship health scores. " +
        "Use to surface who needs a check-in before the weekly review.",
      inputSchema: {
        type: "object",
        properties: {
          maxHealth: {
            type: "number",
            description: "Return stakeholders with health score ≤ this value (0-4). Default 2.",
          },
          tier: {
            type: "string",
            description: "Filter by tierTag (exec, peer, report, partner, vendor).",
          },
          limit: { type: "number", description: "Max results. Default 20." },
        },
        additionalProperties: false,
      },
      run: runListStakeholdersNeedingTouch,
    },
  };
}
