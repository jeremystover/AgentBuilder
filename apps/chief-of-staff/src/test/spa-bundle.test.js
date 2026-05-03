/**
 * spa-bundle.test.js — guard against SPA-as-string regressions.
 *
 * The /app/app.js bundle is built by concatenating three template
 * literals (web-ui-kit's SPA_CORE_JS + this agent's SPA_PAGES_JS +
 * SPA_PAGES2_JS). Two classes of bug have shipped past code review:
 *
 *   1. String.raw vs regular template literal mismatch — backslashes in
 *      the source survived to the served bundle as literal \\ + char,
 *      producing "Invalid or unexpected token" in the browser.
 *   2. Top-level `const` redeclarations between concatenated chunks —
 *      e.g. spa-pages re-destructuring `$` that spa-core already declared
 *      at the top level.
 *
 * Neither is caught by typecheck or wrangler dry-run. This test parses
 * the assembled bundle with `new Function(body)` (which is exactly what
 * the browser does) and fails on syntax / redeclaration errors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SPA_CORE_JS } from "@agentbuilder/web-ui-kit";
import { SPA_PAGES_JS } from "../web/spa-pages.js";
import { SPA_PAGES2_JS } from "../web/spa-pages2.js";

test("SPA bundle parses as valid JavaScript", () => {
  const body = SPA_CORE_JS + "\n" + SPA_PAGES_JS + "\n" + SPA_PAGES2_JS;
  // new Function uses the exact same parser the browser does.
  assert.doesNotThrow(() => new Function(body), "served /app/app.js must parse");
});

test("SPA bundle has expected route patterns", () => {
  const body = SPA_CORE_JS + "\n" + SPA_PAGES_JS + "\n" + SPA_PAGES2_JS;
  // Sanity: the slash-escapes in regex literals must reach the bundle as
  // literal \\/ (the browser then parses as /). If template-literal escape
  // processing strips them, regex parsing fails downstream.
  assert.match(body, /pattern: \/\^#\\\/today\$\//, "Today route regex intact");
  assert.match(body, /pattern: \/\^#\\\/projects\\\/\(\.\+\)\$\//, "Project detail route regex intact");
});

test("SPA bundle does not redeclare top-level identifiers", () => {
  const body = SPA_CORE_JS + "\n" + SPA_PAGES_JS + "\n" + SPA_PAGES2_JS;
  for (const name of ["$", "el", "fmtDate", "api", "toast", "openModal", "attachVoice", "route"]) {
    const matches = body.match(new RegExp(`^const\\s+\\{?\\s*${name.replace("$", "\\$")}[\\s,}=]`, "gm")) || [];
    assert.ok(matches.length <= 1, `${name} declared more than once at top level (found ${matches.length})`);
  }
});
