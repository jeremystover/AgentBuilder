/**
 * observability.js — Minimum viable logging for cron + background work.
 *
 * Two primitives:
 *   - logError(scope, err, context)         structured JSON to console +
 *                                           best-effort append to `Errors` sheet
 *   - runCron(opts, handler)                wraps a scheduled handler with a
 *                                           `CronRuns` row (start/stop/status)
 *                                           and isolates its try/catch
 *
 * Sheet schemas (create these tabs manually in the spreadsheet):
 *
 *   CronRuns:
 *     runId | trigger | startedAt | completedAt | durationMs | status | summary | errorSummary
 *
 *   Errors:
 *     errorId | scope | message | stack | contextJson | createdAt
 *
 * Both helpers are best-effort: if the sheet isn't reachable (bad creds, cold
 * restart, missing tab), we still write to console.error and never throw from
 * the logging path. Never swallow the underlying handler error unless the
 * wrapper is told to (runCron catches and logs; the calling scheduled() uses
 * ctx.waitUntil so one handler cannot block another).
 */

const CRON_RUNS_SHEET = "CronRuns";
const ERRORS_SHEET = "Errors";

function nowIso() {
  return new Date().toISOString();
}

function generateId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

function errToString(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  const msg = err.message || String(err);
  return msg.length > 500 ? msg.slice(0, 500) + "…" : msg;
}

/**
 * Append a structured error record. Logs to console first (always visible),
 * then best-effort appends a row to the `Errors` sheet. Returns the errorId.
 */
export async function logError({ sheets, spreadsheetId, scope, err, context }) {
  const errorId = generateId("err");
  const message = errToString(err);
  const stack = err && err.stack ? String(err.stack).slice(0, 1000) : "";
  const createdAt = nowIso();
  const contextJson = safeStringify(context || {});

  // 1. Always log to console first so Workers logs capture it even if the
  //    sheet write fails.
  console.error(
    `[error] ${JSON.stringify({ errorId, scope, message, createdAt, context: context || {} })}`
  );

  // 2. Best-effort append. Never throw from the logger.
  if (sheets && spreadsheetId) {
    try {
      await sheets.appendRows(ERRORS_SHEET, [
        [errorId, scope, message, stack, contextJson, createdAt],
      ]);
    } catch (writeErr) {
      console.error(
        `[error] Failed to append to ${ERRORS_SHEET}: ${errToString(writeErr)}`
      );
    }
  }

  return errorId;
}

/**
 * Wrap a cron handler with a CronRuns row + isolated try/catch.
 *
 * Usage:
 *   ctx.waitUntil(runCron(
 *     { sheets, spreadsheetId, trigger: "morning-brief", cron: "0 7 * * *" },
 *     async () => { ... }
 *   ));
 *
 * Guarantees:
 *   - Exactly one CronRuns row per invocation (status = "ok" | "error").
 *   - Underlying handler errors are caught and logged (logError + console),
 *     never re-thrown — so one crashing cron cannot kill siblings.
 *   - Handler result is returned on success; null on failure.
 */
export async function runCron({ sheets, spreadsheetId, trigger, cron }, handler) {
  const runId = generateId("run");
  const startedAt = nowIso();
  const startMs = Date.now();

  let status = "ok";
  let result = null;
  let errorSummary = "";
  let summary = "";

  try {
    result = await handler();
    summary = safeStringify(result).slice(0, 500);
    console.log(
      `[cron] ${trigger} complete: ${summary}`
    );
  } catch (err) {
    status = "error";
    errorSummary = errToString(err);
    await logError({
      sheets,
      spreadsheetId,
      scope: `cron:${trigger}`,
      err,
      context: { cron, runId },
    });
    result = null;
  }

  const completedAt = nowIso();
  const durationMs = Date.now() - startMs;

  if (sheets && spreadsheetId) {
    try {
      await sheets.appendRows(CRON_RUNS_SHEET, [
        [
          runId,
          trigger,
          startedAt,
          completedAt,
          String(durationMs),
          status,
          summary,
          errorSummary,
        ],
      ]);
    } catch (writeErr) {
      console.error(
        `[cron] Failed to append to ${CRON_RUNS_SHEET}: ${errToString(writeErr)}`
      );
    }
  }

  return result;
}
