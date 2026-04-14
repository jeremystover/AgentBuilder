import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../tools.js";

function createFakeSheets() {
  const config = []; // [{ key, value, updatedAt }]
  return {
    async readSheetAsObjects(sheet) {
      if (sheet === "Tasks") {
        return [{ taskKey: "t1", title: "Do thing", status: "open", priority: "high", dueAt: "" }];
      }
      if (sheet === "Config") return [...config];
      return [];
    },
    async appendRows(sheet, rows) {
      if (sheet !== "Config") return;
      for (const row of rows) {
        config.push({ key: row[0] ?? "", value: row[1] ?? "", updatedAt: row[2] ?? "" });
      }
    },
    async findRowByKey(sheet, keyField, keyValue) {
      if (sheet !== "Config") return null;
      const idx = config.findIndex((r) => r[keyField] === keyValue);
      if (idx === -1) return null;
      return { rowNum: idx + 2, data: config[idx] };
    },
    async updateRow() { return null; },
  };
}

test("get_prioritized_todo rejects missing context token with structured error", async () => {
  const tools = createTools({ spreadsheetId: "sheet-123", sheets: createFakeSheets() });
  const result = await tools.get_prioritized_todo.run({ range: "today" });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.guardrail, "planning_context_required");
  assert.equal(payload.retryable, true);
  assert.equal(payload.error.code, "MISSING_CONTEXT_TOKEN");
});

test("hydrate_planning_context issues persisted context token accepted by planning call", async () => {
  const tools = createTools({ spreadsheetId: "sheet-123", sheets: createFakeSheets() });
  const hydrated = await tools.hydrate_planning_context.run({ range: "today" });
  const hydratedPayload = JSON.parse(hydrated.content[0].text);
  assert.ok(hydratedPayload.contextToken);
  assert.ok(hydratedPayload.contextExpiresAt);

  const result = await tools.get_prioritized_todo.run({
    range: "today",
    contextToken: hydratedPayload.contextToken,
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.contextToken, hydratedPayload.contextToken);
  assert.equal(typeof payload.contextHydratedAt, "string");
  assert.equal(payload.contextRange, "today");
  assert.equal(typeof payload.contextFreshnessMs, "number");
  assert.ok(Array.isArray(payload.tasks));
});

test("get_prioritized_todo rejects invalid context token with structured error", async () => {
  const tools = createTools({ spreadsheetId: "sheet-123", sheets: createFakeSheets() });
  const result = await tools.get_prioritized_todo.run({ range: "today", contextToken: "ctx_invalid" });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.guardrail, "planning_context_required");
  assert.equal(payload.error.code, "INVALID_CONTEXT_TOKEN");
});
