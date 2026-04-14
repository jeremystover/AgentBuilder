import test from "node:test";
import assert from "node:assert/strict";

import { createTools } from "../tools.js";
import worker from "../worker.js";

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function createMemorySheets(seed = {}) {
  const tables = {
    Tasks: seed.Tasks ? [...seed.Tasks] : [],
    TaskSources: seed.TaskSources ? [...seed.TaskSources] : [],
    Commitments: seed.Commitments ? [...seed.Commitments] : [],
    IntakeQueue: seed.IntakeQueue ? [...seed.IntakeQueue] : [],
    Changesets: seed.Changesets ? [...seed.Changesets] : [],
    AgentRuns: seed.AgentRuns ? [...seed.AgentRuns] : [],
    Stakeholders: seed.Stakeholders ? [...seed.Stakeholders] : [],
    Decisions: seed.Decisions ? [...seed.Decisions] : [],
  };

  const taskColumns = [
    "taskKey", "source", "subject", "title", "from", "date", "startTime", "endTime", "status", "priority", "notes",
    "rawJson", "updatedAt", "ownerType", "ownerId", "dueAt", "projectId", "confidence", "origin",
  ];
  const taskSourceColumns = ["sourceId", "taskKey", "sourceType", "sourceRef", "sourceUri", "excerpt", "confidence", "createdAt"];
  const commitmentColumns = [
    "commitmentId", "ownerType", "ownerId", "description", "dueAt", "status", "sourceType", "sourceRef", "excerpt",
    "projectId", "stakeholderId", "lastNudgedAt", "createdAt", "updatedAt",
  ];
  const intakeColumns = ["intakeId", "kind", "summary", "sourceRef", "payloadJson", "status", "createdAt", "updatedAt"];
  const changesetColumns = [
    "changesetId", "kind", "status", "proposedAt", "proposedBy",
    "addsJson", "updatesJson", "deletesJson", "appliedAt", "appliedBy",
  ];
  const configColumns = ["key", "value", "updatedAt"];

  const columnsBySheet = {
    Tasks: taskColumns,
    TaskSources: taskSourceColumns,
    Commitments: commitmentColumns,
    IntakeQueue: intakeColumns,
    Changesets: changesetColumns,
    Config: configColumns,
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
        if (cols) {
          const obj = Object.fromEntries(cols.map((k, i) => [k, row[i] ?? ""]));
          tables[sheet].push(obj);
        } else {
          tables[sheet].push({ row });
        }
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
      if (cols) {
        tables[sheet][idx] = Object.fromEntries(cols.map((k, i) => [k, values[i] ?? ""]));
      }
      return { ok: true };
    },
  };
}

test("e2e propose→commit invariants: no writes before commit, single-use changeset after commit", async () => {
  const sheets = createMemorySheets();
  const tools = createTools({ spreadsheetId: "sheet-123", sheets });

  const proposed = parseToolResult(await tools.propose_create_task.run({
    title: "Follow up with finance",
    sources: [{ sourceType: "intake", sourceRef: "intake_1", excerpt: "Need budget sign-off" }],
    dueAt: "2026-04-15T17:00:00.000Z",
    priority: "high",
  }));

  assert.equal(sheets.tables.Tasks.length, 0);
  assert.equal(sheets.tables.TaskSources.length, 0);
  assert.ok(proposed.changesetId);

  const committed = parseToolResult(await tools.commit_changeset.run({ changesetId: proposed.changesetId }));
  assert.equal(committed.ok, true);
  assert.equal(sheets.tables.Tasks.length, 1);
  assert.equal(sheets.tables.TaskSources.length, 1);
  assert.equal(sheets.tables.Changesets.length, 1);

  const secondCommit = parseToolResult(await tools.commit_changeset.run({ changesetId: proposed.changesetId }));
  assert.match(secondCommit.error, /Changeset not found or expired/);
});

test("e2e propose→commit invariant: commit without propose fails", async () => {
  const sheets = createMemorySheets();
  const tools = createTools({ spreadsheetId: "sheet-123", sheets });

  const res = parseToolResult(await tools.commit_changeset.run({ changesetId: "cs_missing" }));
  assert.match(res.error, /not found or expired/);
  assert.equal(sheets.tables.Tasks.length, 0);
});

test("automation/internal endpoints deny unauthorized calls (approval failure path)", async () => {
  const env = { MCP_HTTP_KEY: "top-secret" };

  const mcpRes = await worker.fetch(new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }), env, {});
  assert.equal(mcpRes.status, 401);

  const morningRes = await worker.fetch(new Request("https://example.com/internal/morning-brief", {
    method: "POST",
  }), env, {});
  assert.equal(morningRes.status, 401);

  const nudgeRes = await worker.fetch(new Request("https://example.com/internal/commitment-nudges", {
    method: "POST",
  }), env, {});
  assert.equal(nudgeRes.status, 401);
});

test("requireAuth: Bearer header is accepted on /mcp; INTERNAL_CRON_KEY scopes /internal/*", async () => {
  // MCP_HTTP_KEY is NOT set — /internal/* must require INTERNAL_CRON_KEY.
  const env = { MCP_HTTP_KEY: "mcp-key", INTERNAL_CRON_KEY: "cron-key" };

  // /mcp with the correct Bearer token passes auth and reaches JSON-RPC
  // (no body → parse error at the RPC layer, which we accept — the point is
  // it got past 401).
  const mcpOkRes = await worker.fetch(new Request("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer mcp-key" },
    body: "not-json",
  }), env, {});
  assert.notEqual(mcpOkRes.status, 401);

  // /mcp with the internal key is rejected (scopes must not cross).
  const mcpCrossRes = await worker.fetch(new Request("https://example.com/mcp", {
    method: "POST",
    headers: { authorization: "Bearer cron-key" },
  }), env, {});
  assert.equal(mcpCrossRes.status, 401);

  // /internal/* with the MCP key is rejected when INTERNAL_CRON_KEY is set.
  const internalCrossRes = await worker.fetch(new Request("https://example.com/internal/morning-brief", {
    method: "POST",
    headers: { authorization: "Bearer mcp-key" },
  }), env, {});
  assert.equal(internalCrossRes.status, 401);

  // /internal/* with INTERNAL_CRON_KEY passes auth (may still 500 from
  // missing Google creds downstream — we only assert it is NOT 401).
  const internalOkRes = await worker.fetch(new Request("https://example.com/internal/morning-brief", {
    method: "POST",
    headers: { authorization: "Bearer cron-key" },
  }), env, {});
  assert.notEqual(internalOkRes.status, 401);
});

test("requireAuth: legacy ?key= query param still accepted during deprecation window", async () => {
  const env = { MCP_HTTP_KEY: "mcp-key" };

  const res = await worker.fetch(new Request("https://example.com/mcp?key=mcp-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json",
  }), env, {});
  assert.notEqual(res.status, 401);
});

test("cron scheduling routes automation vs default ingest path", async () => {
  const env = {};
  const waitUntilCalls = [];
  const ctx = { waitUntil(promise) { waitUntilCalls.push(promise); } };

  await worker.scheduled({ cron: "0 7 * * *" }, env, ctx);
  await worker.scheduled({ cron: "0 9 * * 1" }, env, ctx);
  await worker.scheduled({ cron: "*/10 * * * *" }, env, ctx);

  assert.equal(waitUntilCalls.length, 3);

  // All branches should fail gracefully in test env with missing credentials.
  await Promise.all(waitUntilCalls.map(async (p) => {
    await p;
  }));
});
