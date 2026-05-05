import test from "node:test";
import assert from "node:assert/strict";

import { createTools } from "../tools.js";
import { filterWaitingReady, waitingTrigger } from "../automation.js";

// In-memory sheets adapter mirroring the one in
// e2e-invariants-automation.test.js but with the migration-0009 wait
// columns on Tasks. Keeps these tests independent so a refactor to the
// other helper doesn't silently break this suite.
function createMemorySheets(seed = {}) {
  const tables = {
    Tasks: seed.Tasks ? [...seed.Tasks] : [],
    TaskSources: seed.TaskSources ? [...seed.TaskSources] : [],
    Commitments: seed.Commitments ? [...seed.Commitments] : [],
    IntakeQueue: seed.IntakeQueue ? [...seed.IntakeQueue] : [],
    Changesets: seed.Changesets ? [...seed.Changesets] : [],
    Stakeholders: seed.Stakeholders ? [...seed.Stakeholders] : [],
  };
  const taskColumns = [
    "taskKey", "source", "subject", "title", "from", "date", "startTime", "endTime",
    "status", "priority", "notes", "rawJson", "updatedAt",
    "ownerType", "ownerId", "dueAt", "projectId", "confidence", "origin",
    "waitReason", "waitDetail", "expectedBy", "nextCheckAt", "lastSnoozedAt",
    "lastSignalAt", "waitOnStakeholderId", "waitOnName", "waitChannel",
    "blockedByTaskKey", "commitmentId",
  ];
  const taskSourceColumns = [
    "sourceId", "taskKey", "sourceType", "sourceRef", "sourceUri", "excerpt", "confidence", "createdAt",
  ];
  const commitmentColumns = [
    "commitmentId", "ownerType", "ownerId", "description", "dueAt", "status",
    "sourceType", "sourceRef", "excerpt", "projectId", "stakeholderId",
    "lastNudgedAt", "createdAt", "updatedAt",
  ];
  const changesetColumns = [
    "changesetId", "kind", "status", "proposedAt", "proposedBy",
    "addsJson", "updatesJson", "deletesJson", "appliedAt", "appliedBy",
  ];
  const intakeColumns = ["intakeId", "kind", "summary", "sourceRef", "payloadJson", "status", "createdAt", "updatedAt"];
  const stakeholderColumns = [
    "stakeholderId", "name", "email", "tierTag", "cadenceDays", "lastInteractionAt", "relationshipHealth",
  ];
  const columnsBySheet = {
    Tasks: taskColumns,
    TaskSources: taskSourceColumns,
    Commitments: commitmentColumns,
    Changesets: changesetColumns,
    IntakeQueue: intakeColumns,
    Stakeholders: stakeholderColumns,
  };

  return {
    tables,
    async readSheetAsObjects(sheet) {
      return [...(tables[sheet] || [])];
    },
    async appendRows(sheet, rows) {
      if (!tables[sheet]) tables[sheet] = [];
      const cols = columnsBySheet[sheet];
      for (const row of rows) {
        if (cols) tables[sheet].push(Object.fromEntries(cols.map((k, i) => [k, row[i] ?? ""])));
        else tables[sheet].push({ row });
      }
    },
    async findRowByKey(sheet, keyField, keyValue) {
      const idx = (tables[sheet] || []).findIndex((r) => r[keyField] === keyValue);
      if (idx === -1) return null;
      return { rowNum: idx + 2, data: tables[sheet][idx] };
    },
    async updateRow(sheet, rowNum, values) {
      const idx = rowNum - 2;
      if (!tables[sheet] || idx < 0 || idx >= tables[sheet].length) return null;
      const cols = columnsBySheet[sheet];
      if (!cols) return { ok: true };
      if (Array.isArray(values)) {
        tables[sheet][idx] = Object.fromEntries(cols.map((k, i) => [k, values[i] ?? ""]));
      } else if (values && typeof values === "object") {
        // Object form: partial update — preserve unspecified columns.
        const merged = { ...tables[sheet][idx] };
        for (const k of cols) if (values[k] !== undefined) merged[k] = values[k] ?? "";
        tables[sheet][idx] = merged;
      }
      return { ok: true };
    },
  };
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

async function seedTask(sheets, taskKey, fields = {}) {
  await sheets.appendRows("Tasks", [[
    taskKey, "manual", "", fields.title || taskKey, "", "", "", "",
    fields.status || "open", fields.priority || "", "",
    "{}", new Date().toISOString(),
    "me", "", fields.dueAt || "", fields.projectId || "", "", "manual",
    // wait fields default to ""
    "", "", "", "", "", "", "", "", "", "", "",
  ]]);
}

// ── 1. set_waiting (person, past expectedBy) → surfaces in waitingReady ─────

test("propose_set_task_waiting(person) with past expectedBy is surfaced by filterWaitingReady", async () => {
  const sheets = createMemorySheets();
  await seedTask(sheets, "T_1", { title: "Get budget signoff" });
  const tools = createTools({ spreadsheetId: "x", sheets });

  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const proposed = parseToolResult(await tools.propose_set_task_waiting.run({
    taskKey: "T_1",
    waitReason: "person",
    waitOnName: "Sara",
    waitChannel: "email",
    expectedBy: yesterday,
  }));
  assert.ok(proposed.changesetId);

  const committed = parseToolResult(await tools.commit_changeset.run({ changesetId: proposed.changesetId }));
  assert.equal(committed.ok, true);

  const stored = sheets.tables.Tasks[0];
  assert.equal(stored.status, "waiting");
  assert.equal(stored.waitReason, "person");
  assert.equal(stored.waitOnName, "Sara");
  assert.equal(stored.expectedBy, yesterday);
  // nextCheckAt defaulted to expectedBy when expectedBy was provided.
  assert.equal(stored.nextCheckAt, yesterday);

  const ready = filterWaitingReady(sheets.tables.Tasks, new Date());
  assert.equal(ready.length, 1);
  assert.equal(ready[0].taskKey, "T_1");

  const why = waitingTrigger(stored, new Date());
  assert.match(why, /expected/);
});

// ── 2. set_waiting(assigned) writes a Commitment + links commitmentId ───────

test("propose_set_task_waiting(assigned) creates a Commitment row and links it on the task", async () => {
  const sheets = createMemorySheets();
  await seedTask(sheets, "T_55", { title: "Ship the migration" });
  const tools = createTools({ spreadsheetId: "x", sheets });

  const expectedBy = new Date(Date.now() + 5 * 86400000).toISOString();
  const proposed = parseToolResult(await tools.propose_set_task_waiting.run({
    taskKey: "T_55",
    waitReason: "assigned",
    assigneeName: "Marcus",
    expectedBy,
  }));
  const committed = parseToolResult(await tools.commit_changeset.run({ changesetId: proposed.changesetId }));
  assert.equal(committed.ok, true);

  // Sibling Commitment was written.
  assert.equal(sheets.tables.Commitments.length, 1);
  const cmt = sheets.tables.Commitments[0];
  assert.equal(cmt.ownerType, "other");
  assert.equal(cmt.ownerId, "Marcus");
  assert.equal(cmt.dueAt, expectedBy);
  assert.equal(cmt.status, "open");
  assert.equal(cmt.description, "Ship the migration");

  // Task picked up the link and the assigned wait reason.
  const task = sheets.tables.Tasks[0];
  assert.equal(task.status, "waiting");
  assert.equal(task.waitReason, "assigned");
  assert.equal(task.commitmentId, cmt.commitmentId);
  assert.equal(task.waitOnName, "Marcus");
});

// ── 3. dependency: completing the blocker stamps nextCheckAt on dependents ──

test("completing a blocker stamps nextCheckAt=now on waiting tasks that list it as blockedByTaskKey", async () => {
  const sheets = createMemorySheets();
  await seedTask(sheets, "T_blocker", { title: "Land the build" });
  await seedTask(sheets, "T_dependent", { title: "Run integration suite" });
  const tools = createTools({ spreadsheetId: "x", sheets });

  // Mark the dependent as waiting on T_blocker.
  const wp = parseToolResult(await tools.propose_set_task_waiting.run({
    taskKey: "T_dependent",
    waitReason: "dependency",
    blockedByTaskKey: "T_blocker",
    nextCheckAt: new Date(Date.now() + 30 * 86400000).toISOString(), // far future
  }));
  parseToolResult(await tools.commit_changeset.run({ changesetId: wp.changesetId }));

  const beforeStamp = sheets.tables.Tasks.find((r) => r.taskKey === "T_dependent").nextCheckAt;

  // Complete the blocker — the dependent's nextCheckAt should advance to ~now.
  const cp = parseToolResult(await tools.propose_complete_task.run({
    taskKey: "T_blocker",
    completionNote: "build green",
  }));
  const cc = parseToolResult(await tools.commit_changeset.run({ changesetId: cp.changesetId }));
  assert.equal(cc.ok, true);
  assert.ok(cc.results.some((r) => r.action === "stamped_dependent" && r.taskKey === "T_dependent"));

  const after = sheets.tables.Tasks.find((r) => r.taskKey === "T_dependent");
  assert.notEqual(after.nextCheckAt, beforeStamp);
  // Dependent now surfaces in the waiting-ready filter.
  const ready = filterWaitingReady(sheets.tables.Tasks, new Date());
  assert.ok(ready.some((t) => t.taskKey === "T_dependent"));
});

// ── 4. propose_snooze_task backoff: 3d → 7d on second snooze ────────────────

test("propose_snooze_task without `until` applies a 3d → 7d backoff", async () => {
  const sheets = createMemorySheets();
  await seedTask(sheets, "T_2", { title: "Reach back out", status: "waiting" });
  const tools = createTools({ spreadsheetId: "x", sheets });

  const p1 = parseToolResult(await tools.propose_snooze_task.run({ taskKey: "T_2" }));
  parseToolResult(await tools.commit_changeset.run({ changesetId: p1.changesetId }));
  const after1 = sheets.tables.Tasks[0];
  const delta1Days = Math.round((new Date(after1.nextCheckAt) - Date.now()) / 86400000);
  assert.ok(delta1Days >= 2 && delta1Days <= 4, `expected ~3d, got ${delta1Days}d`);
  assert.ok(after1.lastSnoozedAt);

  const p2 = parseToolResult(await tools.propose_snooze_task.run({ taskKey: "T_2" }));
  parseToolResult(await tools.commit_changeset.run({ changesetId: p2.changesetId }));
  const after2 = sheets.tables.Tasks[0];
  const delta2Days = Math.round((new Date(after2.nextCheckAt) - Date.now()) / 86400000);
  assert.ok(delta2Days >= 6 && delta2Days <= 8, `expected ~7d after second snooze, got ${delta2Days}d`);
});

// ── 5. propose_resume_task clears all wait fields ───────────────────────────

test("propose_resume_task clears wait fields and flips status back to open", async () => {
  const sheets = createMemorySheets();
  await seedTask(sheets, "T_3", { title: "Q4 plan" });
  const tools = createTools({ spreadsheetId: "x", sheets });

  // Set waiting, then resume.
  const setP = parseToolResult(await tools.propose_set_task_waiting.run({
    taskKey: "T_3",
    waitReason: "person",
    waitOnName: "Alex",
    expectedBy: new Date(Date.now() + 86400000).toISOString(),
  }));
  parseToolResult(await tools.commit_changeset.run({ changesetId: setP.changesetId }));
  assert.equal(sheets.tables.Tasks[0].status, "waiting");

  const resP = parseToolResult(await tools.propose_resume_task.run({ taskKey: "T_3", reason: "Alex replied" }));
  parseToolResult(await tools.commit_changeset.run({ changesetId: resP.changesetId }));

  const t = sheets.tables.Tasks[0];
  assert.equal(t.status, "open");
  assert.equal(t.waitReason, "");
  assert.equal(t.waitOnName, "");
  assert.equal(t.expectedBy, "");
  assert.equal(t.nextCheckAt, "");
  assert.equal(t.blockedByTaskKey, "");
});

// ── 6. filterWaitingReady semantics: lastSignalAt newer than updatedAt ──────

test("filterWaitingReady picks up tasks where lastSignalAt is newer than updatedAt", async () => {
  const past = new Date(Date.now() - 2 * 86400000).toISOString();
  const recent = new Date(Date.now() - 60_000).toISOString();
  const tasks = [
    {
      taskKey: "T_a", status: "waiting", waitReason: "person",
      updatedAt: past, lastSignalAt: recent, expectedBy: "", nextCheckAt: "",
    },
    {
      taskKey: "T_b", status: "waiting", waitReason: "person",
      updatedAt: recent, lastSignalAt: past, expectedBy: "", nextCheckAt: "",
    },
    {
      taskKey: "T_c", status: "open", waitReason: "", updatedAt: past, lastSignalAt: "",
    },
  ];
  const ready = filterWaitingReady(tasks, new Date());
  assert.deepEqual(ready.map((t) => t.taskKey), ["T_a"]);
});

// ── 7. preserves wait fields on a generic task update ───────────────────────

test("propose_update_task does not clear wait fields (so a priority change keeps the wait)", async () => {
  const sheets = createMemorySheets();
  await seedTask(sheets, "T_4", { title: "Investor follow-up" });
  const tools = createTools({ spreadsheetId: "x", sheets });

  // Set waiting first.
  const expectedBy = new Date(Date.now() + 4 * 86400000).toISOString();
  const setP = parseToolResult(await tools.propose_set_task_waiting.run({
    taskKey: "T_4",
    waitReason: "person",
    waitOnName: "Pat",
    expectedBy,
  }));
  parseToolResult(await tools.commit_changeset.run({ changesetId: setP.changesetId }));

  // Now bump priority via the generic update path. Wait fields must survive.
  const updP = parseToolResult(await tools.propose_update_task.run({
    taskKey: "T_4",
    patch: { priority: "high" },
    sources: [{ sourceType: "manual", sourceRef: "ui" }],
  }));
  parseToolResult(await tools.commit_changeset.run({ changesetId: updP.changesetId }));

  const t = sheets.tables.Tasks[0];
  assert.equal(t.priority, "high");
  assert.equal(t.status, "waiting");
  assert.equal(t.waitOnName, "Pat");
  assert.equal(t.expectedBy, expectedBy);
});
