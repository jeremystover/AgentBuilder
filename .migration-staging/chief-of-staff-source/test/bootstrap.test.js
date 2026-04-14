import test from "node:test";
import assert from "node:assert/strict";

import { bootstrapSheets, SHEET_SCHEMAS } from "../bootstrap.js";

/**
 * Minimal in-memory mock for the sheets client. Tracks createSheetTab +
 * setHeaderRow calls so we can assert non-destructive merge semantics.
 */
function createMockSheets({ tabs = {}, failList = false } = {}) {
  const state = { tabs, setHeaderCalls: [], createTabCalls: [] };
  return {
    state,
    async listSheetTabs() {
      if (failList) throw new Error("list failed");
      return Object.keys(state.tabs);
    },
    async readSheet(name) {
      const headers = state.tabs[name]?.headers || [];
      return { headers, rows: [] };
    },
    async createSheetTab(name) {
      state.createTabCalls.push(name);
      state.tabs[name] = { headers: [] };
    },
    async setHeaderRow(name, headers) {
      state.setHeaderCalls.push({ name, headers });
      if (!state.tabs[name]) state.tabs[name] = {};
      state.tabs[name].headers = headers;
    },
  };
}

test("bootstrapSheets creates missing tabs with full canonical headers", async () => {
  const mock = createMockSheets({ tabs: {} });
  const report = await bootstrapSheets(mock);

  // Every schema tab should be listed as created.
  for (const name of Object.keys(SHEET_SCHEMAS)) {
    assert.ok(report.created.includes(name), `expected ${name} in created`);
  }

  // The Changesets tab (the one that caused our incident) should exist with
  // the full column set.
  assert.deepEqual(
    mock.state.tabs.Changesets.headers,
    SHEET_SCHEMAS.Changesets,
    "Changesets tab should have canonical headers",
  );
});

test("bootstrapSheets is idempotent when schema already matches", async () => {
  const tabs = {};
  for (const [name, cols] of Object.entries(SHEET_SCHEMAS)) {
    tabs[name] = { headers: [...cols] };
  }
  const mock = createMockSheets({ tabs });
  const report = await bootstrapSheets(mock);

  assert.equal(report.created.length, 0, "nothing new should be created");
  assert.equal(report.columnsAppended.length, 0, "no columns should be appended");
  assert.equal(report.headersWritten.length, 0, "no headers should be rewritten");
  assert.equal(report.errors.length, 0);
  assert.equal(mock.state.createTabCalls.length, 0);
  assert.equal(mock.state.setHeaderCalls.length, 0);
});

test("bootstrapSheets appends missing columns non-destructively", async () => {
  // Simulate an older Tasks tab that is missing newer columns and also has
  // a user-added custom column. The merge must keep the user's column and
  // append the missing schema columns to the end.
  const tabs = {
    Tasks: { headers: ["taskKey", "title", "status", "myCustomColumn"] },
  };
  const mock = createMockSheets({ tabs });
  const report = await bootstrapSheets(mock);

  const tasksUpdate = report.columnsAppended.find((x) => x.name === "Tasks");
  assert.ok(tasksUpdate, "Tasks should be listed as appended");

  // The custom column must still be in place
  const finalHeaders = mock.state.tabs.Tasks.headers;
  assert.ok(finalHeaders.includes("myCustomColumn"));
  // All expected columns must now be present
  for (const col of SHEET_SCHEMAS.Tasks) {
    assert.ok(finalHeaders.includes(col), `Tasks headers should contain ${col}`);
  }
  // Non-schema "myCustomColumn" should show up in unknownColumns as a warning
  const extras = report.unknownColumns.find((x) => x.name === "Tasks");
  assert.ok(extras);
  assert.ok(extras.extras.includes("myCustomColumn"));
});

test("bootstrapSheets writes headers to an existing but empty tab", async () => {
  const tabs = { Changesets: { headers: [] } };
  const mock = createMockSheets({ tabs });
  const report = await bootstrapSheets(mock);

  assert.ok(report.headersWritten.includes("Changesets"));
  assert.deepEqual(
    mock.state.tabs.Changesets.headers,
    SHEET_SCHEMAS.Changesets,
  );
});

test("bootstrapSheets reports errors but does not throw", async () => {
  const mock = createMockSheets({ failList: true });
  const report = await bootstrapSheets(mock);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].step, "listSheetTabs");
});
