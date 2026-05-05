/**
 * reviews.js — Phase 2 review and decision journal tools.
 *
 * Factory: createReviewTools({ spreadsheetId, sheets }) returns the tools object.
 * Works in Cloudflare Workers (no Node.js dependencies).
 */

function formatContent(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function isOpen(status) {
  const s = String(status || "").toLowerCase();
  return !s || s === "open" || s === "in_progress" || s === "pending" || s === "todo" || s === "waiting";
}

function periodBounds(type) {
  const now = new Date();
  let start, end;

  if (type === "day") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(start.getTime() + 86400000);
  } else if (type === "week") {
    const day = now.getDay(); // 0=Sun
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
    end = new Date(start.getTime() + 7 * 86400000);
  } else if (type === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else {
    // custom — expects startDate/endDate args
    return null;
  }

  return { start, end };
}

/**
 * createReviewTools({ spreadsheetId, sheets }) — review + decision tool registry.
 */
export function createReviewTools({ spreadsheetId, sheets }) {
  const { readSheetAsObjects, appendRows } = sheets;

  // ── generate_period_review ──────────────────────────────────────────────
  async function runGeneratePeriodReview(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

    const type = args.type || "week";
    const save = !!args.save;
    const customStart = args.startDate ? new Date(args.startDate) : null;
    const customEnd = args.endDate ? new Date(args.endDate) : null;

    const bounds = periodBounds(type);
    const start = customStart || (bounds ? bounds.start : new Date(Date.now() - 7 * 86400000));
    const end = customEnd || (bounds ? bounds.end : new Date());

    try {
      const [tasks, commitments, decisions, stakeholders] = await Promise.all([
        readSheetAsObjects("Tasks").catch(() => []),
        readSheetAsObjects("Commitments").catch(() => []),
        readSheetAsObjects("Decisions").catch(() => []),
        readSheetAsObjects("Stakeholders").catch(() => []),
      ]);

      // Tasks completed during the period
      const tasksCompleted = tasks
        .filter((t) => {
          const status = String(t.status || "").toLowerCase();
          if (status !== "done" && status !== "complete" && status !== "completed") return false;
          const updated = t.updatedAt ? new Date(t.updatedAt) : null;
          return updated && updated >= start && updated < end;
        })
        .map((t) => ({ taskKey: t.taskKey, title: t.title || t.subject }));

      // Tasks that were due during the period but still open (missed)
      const tasksMissed = tasks
        .filter((t) => {
          if (!isOpen(t.status)) return false;
          if (!t.dueAt) return false;
          const due = new Date(t.dueAt);
          return due >= start && due < end;
        })
        .map((t) => ({
          taskKey: t.taskKey,
          title: t.title || t.subject,
          dueAt: t.dueAt,
          daysOverdue: Math.round((Date.now() - new Date(t.dueAt).getTime()) / 86400000),
        }));

      // Commitment summary
      const myCommitmentsResolved = commitments.filter((c) => {
        if (String(c.ownerType) !== "me") return false;
        const status = String(c.status || "").toLowerCase();
        if (status !== "done" && status !== "dropped") return false;
        const updated = c.updatedAt ? new Date(c.updatedAt) : null;
        return updated && updated >= start && updated < end;
      }).length;

      const myCommitmentsOverdue = commitments.filter((c) =>
        String(c.ownerType) === "me" && isOpen(c.status) && c.dueAt && new Date(c.dueAt) < end
      ).length;

      const theirCommitmentsOverdue = commitments.filter((c) =>
        String(c.ownerType) === "other" && isOpen(c.status) && c.dueAt && new Date(c.dueAt) < end
      ).map((c) => ({
        commitmentId: c.commitmentId,
        ownerId: c.ownerId,
        description: c.description,
        dueAt: c.dueAt,
      }));

      // Decisions logged during the period
      const periodDecisions = decisions.filter((d) => {
        const created = d.createdAt ? new Date(d.createdAt) : null;
        return created && created >= start && created < end;
      }).map((d) => ({ decisionId: d.decisionId, title: d.title, decisionDate: d.decisionDate }));

      // Relationship health snapshot (top-tier stakeholders)
      const relationshipSnapshot = stakeholders
        .filter((s) => s.tierTag === "exec" || s.tierTag === "peer")
        .map((s) => {
          const daysSinceLast = s.lastInteractionAt
            ? Math.round((Date.now() - new Date(s.lastInteractionAt).getTime()) / 86400000)
            : null;
          const cadence = Number(s.cadenceDays) || 14;
          const health = !s.lastInteractionAt ? 0
            : daysSinceLast <= 7 ? 4
            : daysSinceLast <= cadence ? 3
            : daysSinceLast <= cadence * 1.5 ? 2
            : daysSinceLast <= cadence * 2 ? 1 : 0;
          return { name: s.name, email: s.email, tierTag: s.tierTag, health, daysSinceLast };
        })
        .sort((a, b) => a.health - b.health)
        .slice(0, 10);

      // Still-open tasks due next period
      const nextPeriodEnd = new Date(end.getTime() + (type === "day" ? 86400000 : type === "week" ? 7 * 86400000 : 30 * 86400000));
      const upcomingTasks = tasks
        .filter((t) => isOpen(t.status) && t.dueAt && new Date(t.dueAt) >= end && new Date(t.dueAt) < nextPeriodEnd)
        .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
        .slice(0, 10)
        .map((t) => ({ taskKey: t.taskKey, title: t.title || t.subject, dueAt: t.dueAt, priority: t.priority }));

      const review = {
        reviewId: generateId("rev"),
        periodType: type,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
        generatedAt: nowIso(),
        summary: {
          tasksCompleted: tasksCompleted.length,
          tasksMissed: tasksMissed.length,
          myCommitmentsResolved,
          myCommitmentsStillOverdue: myCommitmentsOverdue,
          theirCommitmentsOverdue: theirCommitmentsOverdue.length,
          decisionsLogged: periodDecisions.length,
        },
        tasksCompleted,
        tasksMissed,
        commitments: {
          myResolved: myCommitmentsResolved,
          myOverdue: myCommitmentsOverdue,
          theirOverdue: theirCommitmentsOverdue,
        },
        decisions: periodDecisions,
        relationshipHealth: relationshipSnapshot,
        upcomingNextPeriod: upcomingTasks,
      };

      // Optionally persist to PeriodReviews sheet
      if (save) {
        await appendRows("PeriodReviews", [[
          review.reviewId,
          review.periodType,
          review.startDate,
          review.endDate,
          JSON.stringify(review.tasksCompleted),
          JSON.stringify(review.tasksMissed),
          JSON.stringify(review.decisions),
          JSON.stringify(review.commitments),
          JSON.stringify(review.relationshipHealth),
          "",   // notesText — user can add via update
          review.generatedAt,
          "claude",
          nowIso(),
        ]]);
        review.saved = true;
        review.note = "Saved to PeriodReviews sheet.";
      } else {
        review.note = "Pass save:true to persist this review to the PeriodReviews sheet.";
      }

      return formatContent(review);
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  // ── log_decision ────────────────────────────────────────────────────────
  async function runLogDecision(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });
    if (!args.title || !args.decisionText) {
      return formatContent({ error: "title and decisionText are required" });
    }

    try {
      const id = generateId("dec");
      const now = nowIso();
      await appendRows("Decisions", [[
        id,
        args.title,
        args.decisionText,
        args.rationale || "",
        args.projectId || "",
        JSON.stringify(args.stakeholders || []),
        args.decisionDate || now.slice(0, 10),
        args.revisitDate || "",
        "open",
        args.sourceType || "manual",
        args.sourceRef || "",
        args.excerpt || "",
        now,
        now,
      ]]);

      return formatContent({
        ok: true,
        decisionId: id,
        title: args.title,
        revisitDate: args.revisitDate || null,
        note: args.revisitDate
          ? `Will surface in list_decisions_to_revisit on or after ${args.revisitDate}.`
          : "No revisit date set — add one if you want this surfaced in future reviews.",
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  // ── list_decisions_to_revisit ────────────────────────────────────────────
  async function runListDecisionsToRevisit(args = {}) {
    if (!spreadsheetId) return formatContent({ error: "PPP_SHEETS_SPREADSHEET_ID not set" });

    try {
      const rows = await readSheetAsObjects("Decisions").catch(() => []);
      const cutoff = args.beforeDate ? new Date(args.beforeDate) : new Date();
      const results = rows
        .filter((d) => String(d.status) === "open" && d.revisitDate && new Date(d.revisitDate) <= cutoff)
        .sort((a, b) => String(a.revisitDate).localeCompare(String(b.revisitDate)))
        .map((d) => ({
          decisionId: d.decisionId,
          title: d.title,
          decisionText: d.decisionText,
          decisionDate: d.decisionDate,
          revisitDate: d.revisitDate,
          projectId: d.projectId,
        }));

      return formatContent({
        count: results.length,
        decisions: results,
        note: results.length === 0
          ? "No decisions past their revisit date."
          : "Review each decision — mark superseded/revisited by calling log_decision with updated context.",
      });
    } catch (e) {
      return formatContent({ error: e.message });
    }
  }

  return {
    generate_period_review: {
      description:
        "Generate a structured review for a time period: completed tasks, missed tasks, " +
        "commitment activity, decisions made, relationship health, and upcoming priorities. " +
        "Pass save:true to persist to the PeriodReviews sheet. Use during weekly or monthly reviews.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["day", "week", "month"],
            description: "Period type. Default: week.",
          },
          startDate: { type: "string", description: "ISO date override for period start (optional)." },
          endDate: { type: "string", description: "ISO date override for period end (optional)." },
          save: { type: "boolean", description: "If true, persist the review to the PeriodReviews sheet." },
        },
        additionalProperties: false,
      },
      run: runGeneratePeriodReview,
    },

    log_decision: {
      description:
        "Log a decision to the Decisions sheet for future reference. " +
        "Optionally set a revisitDate so it surfaces in future reviews. " +
        "Use after any significant architectural, strategic, or process decision.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short decision title." },
          decisionText: { type: "string", description: "What was decided." },
          rationale: { type: "string", description: "Why this decision was made." },
          projectId: { type: "string" },
          stakeholders: {
            type: "array",
            items: { type: "string" },
            description: "Names or emails of people involved in the decision.",
          },
          decisionDate: { type: "string", description: "ISO date of the decision. Defaults to today." },
          revisitDate: { type: "string", description: "ISO date to revisit this decision." },
          sourceType: { type: "string" },
          sourceRef: { type: "string" },
          excerpt: { type: "string", description: "Text that captured the decision." },
        },
        required: ["title", "decisionText"],
        additionalProperties: false,
      },
      run: runLogDecision,
    },

    list_decisions_to_revisit: {
      description:
        "Return open decisions whose revisitDate is on or before today (or a specified date). " +
        "Use at the start of a weekly or monthly review.",
      inputSchema: {
        type: "object",
        properties: {
          beforeDate: {
            type: "string",
            description: "ISO date. Return decisions with revisitDate ≤ this date. Default: today.",
          },
        },
        additionalProperties: false,
      },
      run: runListDecisionsToRevisit,
    },
  };
}
