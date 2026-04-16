#!/usr/bin/env node
/**
 * import-xlsx-to-d1.js — Convert the PersonalProductivityProject.xlsx export
 * into a SQL file that can be applied to the D1 database.
 *
 * Usage:
 *   npm install --no-save xlsx          # one-time, if not already installed
 *   node scripts/import-xlsx-to-d1.js [path-to-xlsx] [output-sql]
 *
 * Defaults:
 *   input:  files/PersonalProductivityProject.xlsx
 *   output: migrations/0002_import_data.sql
 *
 * Apply:
 *   wrangler d1 execute chief-of-staff-db --file=migrations/0002_import_data.sql
 *
 * ─── Column alignment notes ──────────────────────────────────────────────────
 *
 * Several spreadsheet tabs have header rows that don't match the data positions
 * because the code writes data in SHEET_SCHEMAS column order while the
 * spreadsheet retained older header layouts. This script maps data by POSITION
 * using the correct column names for each table.
 *
 * Tables with matching headers (imported by header name):
 *   Tasks, Goals, TaskSources, Changesets, CronRuns, Config, AgentRuns, Errors
 *
 * Tables needing position-based remapping:
 *   Projects — data in PROJECT_COLUMNS order, headers from old layout
 *   Meetings — data in SHEET_SCHEMAS.Meetings order, old header names
 *   IntakeQueue — writeIntakeRow writes payloadJson/status/sourceRef swapped
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// xlsx must be installed: npm install --no-save xlsx
import XLSX from "xlsx";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── D1 target columns (from SHEET_SCHEMAS / migration SQL) ──────────────────

const D1_COLUMNS = {
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
  Goals: [
    "goalId", "title", "description", "horizon", "quarter",
    "status", "priority", "targetDate", "successCriteria",
    "stakeholdersJson", "notes", "sourceType", "sourceRef",
    "createdAt", "updatedAt",
  ],
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
  CronRuns: [
    "runId", "trigger", "startedAt", "completedAt", "durationMs", "status",
    "summary", "errorSummary",
  ],
  Errors: [
    "errorId", "scope", "message", "stack", "contextJson", "createdAt",
  ],
};

// ── Position-to-column mappings for misaligned tables ───────────────────────
//
// These define how raw positional data from the spreadsheet maps to D1 column
// names. For tables where headers match data, we use header-based import
// (the position map is the same as the header row).

// Projects: data was written using goals.js PROJECT_COLUMNS order.
// The spreadsheet headers are from an older layout and DO NOT match.
const PROJECTS_POSITION_MAP = [
  "projectId", "name", "goalId", "description", "status", "priority",
  "healthStatus", "nextMilestoneAt", "stakeholdersJson", "notes",
  "sourceType", "sourceRef", "createdAt", "lastTouchedAt", "updatedAt",
];

// Meetings: data was written using ingest.js appendRows order, which
// matches SHEET_SCHEMAS.Meetings. The spreadsheet has old header names
// (source/sourceHost/meetingKey) at positions 9-11.
const MEETINGS_POSITION_MAP = [
  "meetingId", "eventId", "title", "startTime", "endTime", "description",
  "location", "organizer", "attendeesJson", "sourceType", "sourceDomain",
  "sourceRef", "rawJson", "transcriptRef", "zoomMeetingId", "zoomRecordingId",
  "actionItemsExtracted", "createdAt",
];

// IntakeQueue: writeIntakeRow writes [id, kind, summary, payloadJson,
// status, sourceRef, createdAt, updatedAt] but SHEET_SCHEMAS expects
// [..., sourceRef, payloadJson, status, ...]. Data positions 3-5 are swapped.
const INTAKE_POSITION_MAP = [
  "intakeId", "kind", "summary",
  "payloadJson", "status", "sourceRef",  // ← actual write order (swapped vs schema)
  "createdAt", "updatedAt",
];

// ── SQL escaping ────────────────────────────────────────────────────────────

const RESERVED_WORDS = new Set([
  "from", "key", "value", "order", "group", "index", "table", "select",
  "where", "trigger", "status", "description", "location",
]);

function q(name) {
  return RESERVED_WORDS.has(name.toLowerCase()) ? `"${name}"` : name;
}

function sqlEscape(val) {
  if (val == null) return "''";
  const s = String(val);
  if (s === "") return "''";
  return "'" + s.replace(/'/g, "''") + "'";
}

// ── Main ────────────────────────────────────────────────────────────────────

const inputPath = process.argv[2] || resolve(ROOT, "files/PersonalProductivityProject.xlsx");
const outputPath = process.argv[3] || resolve(ROOT, "migrations/0002_import_data.sql");

console.log(`Reading: ${inputPath}`);
const wb = XLSX.readFile(inputPath);

const lines = [
  "-- 0002_import_data.sql",
  "-- Auto-generated by import-xlsx-to-d1.js",
  `-- Source: ${inputPath}`,
  `-- Generated: ${new Date().toISOString()}`,
  "",
];

let totalRows = 0;

for (const [tableName, d1Cols] of Object.entries(D1_COLUMNS)) {
  const sheet = wb.Sheets[tableName];
  if (!sheet) {
    console.log(`  ${tableName}: sheet not found in XLSX — skipping`);
    continue;
  }

  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (raw.length <= 1) {
    console.log(`  ${tableName}: header only, no data — skipping`);
    continue;
  }

  const sheetHeaders = raw[0];
  const dataRows = raw.slice(1);

  // Determine column mapping strategy.
  let positionMap;
  if (tableName === "Projects") {
    positionMap = PROJECTS_POSITION_MAP;
  } else if (tableName === "Meetings") {
    positionMap = MEETINGS_POSITION_MAP;
  } else if (tableName === "IntakeQueue") {
    positionMap = INTAKE_POSITION_MAP;
  } else {
    // Headers match data — use header names as the position map.
    positionMap = sheetHeaders;
  }

  // Build the mapping: for each D1 column, find which position in the raw
  // data row supplies its value.
  const colMapping = []; // { d1Col, sourceIdx }
  for (const d1Col of d1Cols) {
    const idx = positionMap.indexOf(d1Col);
    colMapping.push({ d1Col, sourceIdx: idx });
  }

  lines.push(`-- ── ${tableName} (${dataRows.length} rows) ──`);

  const colList = d1Cols.map(q).join(", ");

  for (const row of dataRows) {
    const vals = colMapping.map(({ sourceIdx }) => {
      if (sourceIdx === -1) return "''";
      return sqlEscape(row[sourceIdx]);
    });
    lines.push(`INSERT INTO "${tableName}" (${colList}) VALUES (${vals.join(", ")});`);
  }

  lines.push("");
  totalRows += dataRows.length;
  console.log(`  ${tableName}: ${dataRows.length} rows`);
}

writeFileSync(outputPath, lines.join("\n"), "utf8");
console.log(`\nWrote ${outputPath} (${totalRows} total rows)`);
console.log(`\nApply with:\n  wrangler d1 execute chief-of-staff-db --file=${outputPath}`);
