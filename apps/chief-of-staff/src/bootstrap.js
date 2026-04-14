/**
 * bootstrap.js — Verify + initialize Google Sheets schema.
 *
 * The MCP server treats the spreadsheet as its database. If a tab is missing
 * or has wrong headers, writes and reads will silently fail downstream,
 * producing confusing symptoms (changesets that "expire" immediately, empty
 * hydrate results, etc).
 *
 * `bootstrapSheets(sheets)` walks SHEET_SCHEMAS and:
 *   - Creates any missing tabs with the full canonical header row.
 *   - Appends any missing columns to existing tabs (non-destructive —
 *     existing columns are preserved in-place; new columns go to the end).
 *   - Warns about unknown columns (extra headers not in the schema).
 *   - Never deletes or reorders existing data.
 *
 * Call this once after creating a new spreadsheet, or after bumping schema,
 * via the /internal/bootstrap-sheets endpoint.
 *
 * Schemas are sourced from the column layouts used by the existing write
 * paths — if you add a new sheet, add its schema here too.
 */

export const SHEET_SCHEMAS = {
  Tasks: [
    "taskKey", "source", "subject", "title", "from", "date", "startTime",
    "endTime", "status", "priority", "notes", "rawJson", "updatedAt",
    "ownerType", "ownerId", "dueAt", "projectId", "confidence", "origin",
  ],

  TaskSources: [
    "sourceId", "taskKey", "sourceType", "sourceRef", "sourceUri", "excerpt",
    "confidence", "createdAt",
  ],

  Commitments: [
    "commitmentId", "ownerType", "ownerId", "description", "dueAt", "status",
    "sourceType", "sourceRef", "excerpt", "projectId", "stakeholderId",
    "lastNudgedAt", "createdAt", "updatedAt",
  ],

  IntakeQueue: [
    "intakeId", "kind", "summary", "sourceRef", "payloadJson", "status",
    "createdAt", "updatedAt",
  ],

  Changesets: [
    "changesetId", "kind", "status", "proposedAt", "proposedBy",
    "addsJson", "updatesJson", "deletesJson", "appliedAt", "appliedBy",
  ],

  Config: ["key", "value", "updatedAt"],

  Stakeholders: [
    "stakeholderId", "name", "email", "tierTag", "cadenceDays",
    "lastInteractionAt", "relationshipHealth",
  ],

  // Top-of-hierarchy outcomes. One row per goal. Horizon is fixed to
  // quarterly OKR-style planning — the quarterly-goal-intake skill creates
  // and updates these during the big-picture interview.
  Goals: [
    "goalId", "title", "description", "horizon", "quarter",
    "status", "priority", "targetDate", "successCriteria",
    "stakeholdersJson", "notes", "sourceType", "sourceRef",
    "createdAt", "updatedAt",
  ],

  // Projects ladder up to Goals via goalId. Tasks ladder into Projects via
  // the existing Tasks.projectId column. Both Goals and Projects carry a
  // stakeholdersJson array for many-to-many stakeholder linking without a
  // join table.
  Projects: [
    "projectId", "name", "goalId", "description", "status", "priority",
    "healthStatus", "nextMilestoneAt", "stakeholdersJson", "notes",
    "sourceType", "sourceRef", "createdAt", "lastTouchedAt", "updatedAt",
  ],

  Meetings: [
    "meetingId", "eventId", "title", "startTime", "endTime", "description",
    "location", "organizer", "attendeesJson", "sourceType", "sourceDomain",
    "sourceRef", "rawJson", "transcriptRef", "zoomMeetingId", "zoomRecordingId",
    "actionItemsExtracted", "createdAt",
  ],

  Decisions: [
    "decisionId", "title", "decisionText", "rationale", "projectId",
    "stakeholdersJson", "decisionDate", "revisitDate", "status", "sourceType",
    "sourceRef", "excerpt", "createdAt", "updatedAt",
  ],

  PeriodReviews: [
    "reviewId", "periodType", "startDate", "endDate", "tasksCompletedJson",
    "tasksMissedJson", "decisionsJson", "commitmentsJson",
    "relationshipHealthJson", "notesText", "generatedAt", "generatedBy",
    "updatedAt",
  ],

  AgentRuns: [
    "runId", "sessionType", "summary", "toolsCalledJson",
    "changesetsAppliedJson", "startedAt", "completedAt", "runBy",
  ],

  // Wave 2 observability tabs (see observability.js).
  CronRuns: [
    "runId", "trigger", "startedAt", "completedAt", "durationMs", "status",
    "summary", "errorSummary",
  ],

  Errors: [
    "errorId", "scope", "message", "stack", "contextJson", "createdAt",
  ],
};

/**
 * Bootstrap the spreadsheet to match SHEET_SCHEMAS.
 *
 * Returns:
 *   {
 *     created: [name, ...],                     // tabs newly created
 *     headersWritten: [name, ...],              // empty tabs that got headers
 *     columnsAppended: [{name, added: [...]}],  // tabs that got new columns
 *     ok: [name, ...],                          // tabs already matching schema
 *     unknownColumns: [{name, extras: [...]}],  // tabs with non-schema headers (warn only)
 *     errors: [{name, step, message}],          // per-tab failures
 *   }
 */
export async function bootstrapSheets(sheets) {
  if (!sheets || typeof sheets.listSheetTabs !== "function") {
    throw new Error("bootstrapSheets: sheets client missing listSheetTabs — update sheets.js");
  }

  const report = {
    created: [],
    headersWritten: [],
    columnsAppended: [],
    ok: [],
    unknownColumns: [],
    errors: [],
  };

  let existingTabs;
  try {
    existingTabs = await sheets.listSheetTabs();
  } catch (e) {
    report.errors.push({ name: "_spreadsheet", step: "listSheetTabs", message: e.message });
    return report;
  }
  const existingSet = new Set(existingTabs);

  for (const [name, expectedCols] of Object.entries(SHEET_SCHEMAS)) {
    try {
      if (!existingSet.has(name)) {
        await sheets.createSheetTab(name);
        await sheets.setHeaderRow(name, expectedCols);
        report.created.push(name);
        continue;
      }

      // Tab exists — check headers
      const { headers } = await sheets.readSheet(name);

      if (!headers || headers.length === 0) {
        // Empty tab — write the full header row
        await sheets.setHeaderRow(name, expectedCols);
        report.headersWritten.push(name);
        continue;
      }

      // Non-destructive merge: keep existing headers in place, append missing
      // expected columns at the end. This preserves any data under extra
      // columns the user might have added manually.
      const missing = expectedCols.filter((c) => !headers.includes(c));
      if (missing.length > 0) {
        const merged = [...headers, ...missing];
        await sheets.setHeaderRow(name, merged);
        report.columnsAppended.push({ name, added: missing });
      } else {
        report.ok.push(name);
      }

      // Warn on any headers that aren't in our schema (could be user
      // additions OR typos — we leave them alone, just surface them).
      const extras = headers.filter((h) => !expectedCols.includes(h));
      if (extras.length > 0) {
        report.unknownColumns.push({ name, extras });
      }
    } catch (e) {
      report.errors.push({ name, step: "bootstrap", message: e.message });
    }
  }

  return report;
}
