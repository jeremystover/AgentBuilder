import test from "node:test";
import assert from "node:assert/strict";

import { renderStateMarkdown } from "../state-export.js";

const SAMPLE_GOALS = [
  {
    goalId: "goal_1",
    title: "Ship v2 platform",
    description: "Land the new platform with customers.",
    quarter: "2026Q2",
    status: "active",
    priority: "high",
    targetDate: "2026-06-30",
    successCriteria: "100 DAU and NPS > 40",
    stakeholdersJson: JSON.stringify(["sh_alice", "sh_bob"]),
    notes: "",
  },
  {
    goalId: "goal_2",
    title: "Dormant goal",
    status: "dropped",
    stakeholdersJson: "[]",
  },
];

const SAMPLE_PROJECTS = [
  {
    projectId: "proj_1",
    name: "Migration tooling",
    goalId: "goal_1",
    status: "active",
    healthStatus: "on_track",
    nextMilestoneAt: "2026-04-30",
    stakeholdersJson: JSON.stringify(["sh_alice"]),
  },
  {
    projectId: "proj_2",
    name: "Orphan project",
    goalId: "",
    status: "active",
    healthStatus: "unknown",
    stakeholdersJson: "[]",
  },
];

const SAMPLE_TASKS = [
  { taskKey: "t1", title: "Finish dry-run", status: "open", projectId: "proj_1", dueAt: "2026-04-20" },
  { taskKey: "t2", title: "Done task", status: "done", projectId: "proj_1" },
  { taskKey: "t3", title: "Orphan task", status: "open", projectId: "" },
];

const SAMPLE_STAKEHOLDERS = [
  { stakeholderId: "sh_alice", name: "Alice", email: "alice@example.com", tierTag: "peer" },
  { stakeholderId: "sh_bob", name: "Bob", email: "bob@example.com", tierTag: "exec" },
];

test("renderStateMarkdown renders goals with their child projects and tasks", () => {
  const md = renderStateMarkdown({
    goals: SAMPLE_GOALS,
    projects: SAMPLE_PROJECTS,
    tasks: SAMPLE_TASKS,
    stakeholders: SAMPLE_STAKEHOLDERS,
  });

  assert.match(md, /# Current State/);
  assert.match(md, /Ship v2 platform/);
  assert.match(md, /Success criteria:.*100 DAU/);
  assert.match(md, /Project: Migration tooling/);
  assert.match(md, /Finish dry-run/);
});

test("renderStateMarkdown excludes dropped goals and completed tasks", () => {
  const md = renderStateMarkdown({
    goals: SAMPLE_GOALS,
    projects: SAMPLE_PROJECTS,
    tasks: SAMPLE_TASKS,
    stakeholders: SAMPLE_STAKEHOLDERS,
  });

  assert.doesNotMatch(md, /Dormant goal/);
  assert.doesNotMatch(md, /Done task/);
});

test("renderStateMarkdown surfaces orphan projects and orphan tasks", () => {
  const md = renderStateMarkdown({
    goals: SAMPLE_GOALS,
    projects: SAMPLE_PROJECTS,
    tasks: SAMPLE_TASKS,
    stakeholders: SAMPLE_STAKEHOLDERS,
  });

  assert.match(md, /Unassigned Projects/);
  assert.match(md, /Orphan project/);
  assert.match(md, /Orphan Tasks/);
  assert.match(md, /Orphan task/);
});

test("renderStateMarkdown resolves stakeholder IDs to names", () => {
  const md = renderStateMarkdown({
    goals: SAMPLE_GOALS,
    projects: SAMPLE_PROJECTS,
    tasks: SAMPLE_TASKS,
    stakeholders: SAMPLE_STAKEHOLDERS,
  });

  assert.match(md, /stakeholders: Alice, Bob/);
});

test("renderStateMarkdown filters to a single quarter when requested", () => {
  const goals = [
    { goalId: "g_q2", title: "Q2 goal", status: "active", quarter: "2026Q2", stakeholdersJson: "[]" },
    { goalId: "g_q3", title: "Q3 goal", status: "active", quarter: "2026Q3", stakeholdersJson: "[]" },
  ];
  const md = renderStateMarkdown({
    goals,
    projects: [],
    tasks: [],
    stakeholders: [],
    filter: { quarter: "2026Q2" },
  });

  assert.match(md, /Q2 goal/);
  assert.doesNotMatch(md, /Q3 goal/);
  assert.match(md, /Quarter: 2026Q2/);
});

test("renderStateMarkdown handles empty state with a friendly placeholder", () => {
  const md = renderStateMarkdown({ goals: [], projects: [], tasks: [], stakeholders: [] });
  assert.match(md, /No active goals/);
  assert.match(md, /quarterly-goal-intake/);
});
