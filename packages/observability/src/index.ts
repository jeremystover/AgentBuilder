/**
 * @agentbuilder/observability
 *
 * Fleet-wide cron + error logging into the shared `agentbuilder-core` D1.
 *
 * Two primitives:
 *   - runCron(env, opts, handler)   wraps a scheduled handler. Writes one
 *                                   `cron_runs` row per invocation
 *                                   (start/end/status/duration/summary)
 *                                   and isolates the handler's try/catch.
 *   - logError(env, scope, err, ctx)  appends a structured row to
 *                                     `cron_errors` and console.error.
 *
 * Best-effort: if DB is missing or the write fails, we still write to
 * console and never throw from the logging path. Underlying handler
 * errors are caught so one crashing cron can't kill siblings.
 *
 * The dashboard in apps/agent-builder reads these tables to surface "last
 * run / next run / errors" for every cron in the fleet.
 */

export const CRON_RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_runs (
  run_id        TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  cron_expr     TEXT DEFAULT '',
  started_at    TEXT NOT NULL,
  completed_at  TEXT DEFAULT '',
  duration_ms   INTEGER DEFAULT 0,
  status        TEXT NOT NULL,
  summary       TEXT DEFAULT '',
  error_summary TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_agent_started
  ON cron_runs(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status
  ON cron_runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_trigger_started
  ON cron_runs(agent_id, trigger, started_at DESC);
`.trim();

export const CRON_ERRORS_SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_errors (
  error_id    TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  scope       TEXT NOT NULL,
  message     TEXT DEFAULT '',
  stack       TEXT DEFAULT '',
  context     TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cron_errors_agent_created
  ON cron_errors(agent_id, created_at DESC);
`.trim();

export interface ObservabilityEnv {
  /** D1 binding for the shared agentbuilder-core database. */
  AGENTBUILDER_CORE_DB?: D1Database;
}

export type CronStatus = 'ok' | 'error';

export interface RunCronOpts {
  agentId: string;
  trigger: string;
  cron?: string;
}

export interface CronRunRow {
  run_id: string;
  agent_id: string;
  trigger: string;
  cron_expr: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  status: CronStatus;
  summary: string;
  error_summary: string;
}

export interface CronErrorRow {
  error_id: string;
  agent_id: string;
  scope: string;
  message: string;
  stack: string;
  context: string;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // fall through to String()
  }
  try {
    return String(value);
  } catch {
    return '';
  }
}

function errToString(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    const msg = err.message || String(err);
    return msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
  }
  return safeStringify(err).slice(0, 500);
}

function getDb(env: ObservabilityEnv): D1Database | null {
  return env.AGENTBUILDER_CORE_DB ?? null;
}

/**
 * Append a structured error record. Always logs to console first, then
 * best-effort appends to `cron_errors`. Never throws.
 */
export async function logError(
  env: ObservabilityEnv,
  agentId: string,
  scope: string,
  err: unknown,
  context?: Record<string, unknown>,
): Promise<string> {
  const errorId = generateId('err');
  const message = errToString(err);
  const stack =
    err && err instanceof Error && err.stack ? String(err.stack).slice(0, 2000) : '';
  const createdAt = nowIso();
  const contextJson = safeStringify(context ?? {});

  console.error(
    `[error] ${safeStringify({ errorId, agentId, scope, message, createdAt, context: context ?? {} })}`,
  );

  const db = getDb(env);
  if (db) {
    try {
      await db
        .prepare(
          `INSERT INTO cron_errors (error_id, agent_id, scope, message, stack, context, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(errorId, agentId, scope, message, stack, contextJson, createdAt)
        .run();
    } catch (writeErr) {
      console.error(`[error] failed to insert cron_errors: ${errToString(writeErr)}`);
    }
    // Also surface cron errors in the fleet-wide bug-triage tables.
    try {
      await writeFleetError(db, {
        errorId,
        agentId,
        source: 'cron',
        fingerprint: fingerprintOf(message, stack),
        message,
        stack,
        context: contextJson,
        createdAt,
      });
    } catch (writeErr) {
      console.error(`[error] failed to write fleet_errors: ${errToString(writeErr)}`);
    }
  }

  return errorId;
}

// ── Fleet-wide error capture + bug triage ─────────────────────────────────

export type ErrorSource = 'request' | 'cron' | 'queue' | 'frontend';

/** FNV-1a 32-bit hash — stable, synchronous, good enough for grouping. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Group like errors: strip ids/numbers from message + top stack frame. */
function fingerprintOf(message: string, stack: string): string {
  const topFrame =
    stack.split('\n').map((l) => l.trim()).find((l) => l.startsWith('at ')) ?? '';
  const norm = (s: string) => s.replace(/0x[0-9a-f]+/gi, '0xN').replace(/\d+/g, 'N');
  return fnv1a(norm(message) + '|' + norm(topFrame));
}

async function writeFleetError(
  db: D1Database,
  row: {
    errorId: string;
    agentId: string;
    source: ErrorSource;
    fingerprint: string;
    message: string;
    stack: string;
    context: string;
    createdAt: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO fleet_errors
           (error_id, agent_id, source, fingerprint, message, stack, context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.errorId, row.agentId, row.source, row.fingerprint,
        row.message, row.stack, row.context, row.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO bug_tickets
           (fingerprint, agent_id, source, status, sample_message, occurrences, first_seen, last_seen)
         VALUES (?, ?, ?, 'open', ?, 1, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           occurrences = occurrences + 1,
           last_seen   = excluded.last_seen,
           status      = CASE WHEN bug_tickets.status IN ('fixed', 'wontfix')
                              THEN 'open' ELSE bug_tickets.status END`,
      )
      .bind(
        row.fingerprint, row.agentId, row.source,
        row.message.slice(0, 300), row.createdAt, row.createdAt,
      ),
  ]);
}

/**
 * Record a non-cron error (HTTP request / queue / frontend). Inserts a
 * `fleet_errors` occurrence and upserts the `bug_tickets` row. Never throws;
 * returns the fingerprint. The /fleet-doctor session triages from these rows.
 */
export async function logRequestError(
  env: ObservabilityEnv,
  agentId: string,
  source: ErrorSource,
  err: unknown,
  context?: Record<string, unknown>,
): Promise<string> {
  const errorId = generateId('ferr');
  const message = errToString(err);
  const stack =
    err && err instanceof Error && err.stack ? String(err.stack).slice(0, 2000) : '';
  const createdAt = nowIso();
  const fingerprint = fingerprintOf(message, stack);

  console.error(
    `[error] ${safeStringify({ errorId, agentId, source, fingerprint, message, createdAt })}`,
  );

  const db = getDb(env);
  if (db) {
    try {
      await writeFleetError(db, {
        errorId, agentId, source, fingerprint,
        message, stack, context: safeStringify(context ?? {}), createdAt,
      });
    } catch (writeErr) {
      console.error(`[error] failed to write fleet_errors: ${errToString(writeErr)}`);
    }
  }
  return fingerprint;
}

/**
 * Wrap a Worker `fetch` handler. Uncaught throws are recorded to
 * `fleet_errors` and converted to a 500. Routes that already catch their own
 * errors and return a 5xx should call `logRequestError` directly so the real
 * stack is preserved.
 */
export function withObservability<E extends ObservabilityEnv>(
  agentId: string,
  handler: (req: Request, env: E, ctx: ExecutionContext) => Promise<Response>,
): (req: Request, env: E, ctx: ExecutionContext) => Promise<Response> {
  return async (req, env, ctx) => {
    try {
      return await handler(req, env, ctx);
    } catch (err) {
      ctx.waitUntil(
        logRequestError(env, agentId, 'request', err, {
          method: req.method,
          url: req.url,
        }),
      );
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  };
}

/**
 * Intake handler for browser-reported errors. Mount at
 * `POST /api/v1/client-error` (public). The frontend posts
 * `{ message, stack?, url? }` via `navigator.sendBeacon`.
 */
export async function handleClientError(
  req: Request,
  env: ObservabilityEnv,
  agentId: string,
): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // ignore malformed payloads
  }
  const message = typeof body.message === 'string' ? body.message : 'unknown client error';
  const err = new Error(message);
  if (typeof body.stack === 'string') err.stack = body.stack;
  await logRequestError(env, agentId, 'frontend', err, {
    url: typeof body.url === 'string' ? body.url : '',
    userAgent: req.headers.get('user-agent') ?? '',
  });
  return new Response(null, { status: 204 });
}

/**
 * Wrap a cron handler with a `cron_runs` row + isolated try/catch.
 *
 *   await runCron(env, { agentId: 'cfo', trigger: 'nightly-sync', cron: '0 9 * * *' }, async () => {
 *     return await syncTeller();
 *   });
 *
 * Guarantees:
 *   - Exactly one cron_runs row per invocation (status = 'ok' | 'error').
 *   - Underlying errors are caught + logged via logError; never re-thrown.
 *   - Returns the handler result on success, or null on failure.
 */
export async function runCron<T>(
  env: ObservabilityEnv,
  opts: RunCronOpts,
  handler: () => Promise<T> | T,
): Promise<T | null> {
  const runId = generateId('run');
  const startedAt = nowIso();
  const startMs = Date.now();
  const cronExpr = opts.cron ?? '';

  let status: CronStatus = 'ok';
  let result: T | null = null;
  let errorSummary = '';
  let summary = '';

  try {
    result = await handler();
    summary = safeStringify(result).slice(0, 1000);
    console.log(`[cron] ${opts.agentId}/${opts.trigger} ok: ${summary}`);
  } catch (err) {
    status = 'error';
    errorSummary = errToString(err);
    await logError(env, opts.agentId, `cron:${opts.trigger}`, err, {
      cron: cronExpr,
      runId,
    });
    result = null;
  }

  const completedAt = nowIso();
  const durationMs = Date.now() - startMs;

  const db = getDb(env);
  if (db) {
    try {
      await db
        .prepare(
          `INSERT INTO cron_runs
             (run_id, agent_id, trigger, cron_expr, started_at, completed_at, duration_ms, status, summary, error_summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          opts.agentId,
          opts.trigger,
          cronExpr,
          startedAt,
          completedAt,
          durationMs,
          status,
          summary,
          errorSummary,
        )
        .run();
    } catch (writeErr) {
      console.error(`[cron] failed to insert cron_runs: ${errToString(writeErr)}`);
    }
  }

  return result;
}
