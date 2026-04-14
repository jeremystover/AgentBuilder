import test from "node:test";
import assert from "node:assert/strict";
import { createCrmTools } from "../crm.js";

test("crm tool registry only exposes implemented tools", () => {
  const tools = createCrmTools({
    spreadsheetId: "sheet-123",
    sheets: { readSheetAsObjects: async () => [] },
  });

  assert.deepEqual(Object.keys(tools).sort(), [
    "get_project_360",
    "get_stakeholder_360",
    "list_stakeholders_needing_touch",
  ]);
  assert.equal("propose_link_entities" in tools, false);
});

test("crm tools require spreadsheet id", async () => {
  const tools = createCrmTools({
    spreadsheetId: "",
    sheets: { readSheetAsObjects: async () => [] },
  });

  const result = await tools.get_project_360.run({ projectId: "proj-1" });
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(parsed.error, "PPP_SHEETS_SPREADSHEET_ID not set");
});
