import postgres from 'postgres';
import type { Env } from '../types';

export type Sql = ReturnType<typeof postgres>;

const OPTS = { max: 5, fetch_types: false, prepare: false } as const;

function make(env: Env): Sql {
  return postgres(env.HYPERDRIVE.connectionString, OPTS);
}

/**
 * Open a short-lived Postgres connection through Hyperdrive. Callers are
 * responsible for `await sql.end({ timeout: 5 })` at the end of the
 * request — Workers don't pool connections across requests.
 */
export function db(env: Env): Sql {
  return make(env);
}

function isNetworkError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return msg.includes('network') || msg.includes('connection');
}

/**
 * Run fn with a fresh Postgres client. If fn throws a network/connection
 * error (Neon auto-suspend wakeup), waits 2s and retries once with a new
 * client. Closes both clients on exit.
 */
export async function withDb<T>(env: Env, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = make(env);
  try {
    return await fn(sql);
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    await sql.end({ timeout: 1 }).catch(() => {});
    await new Promise<void>(r => setTimeout(r, 2000));
    const sql2 = make(env);
    try {
      return await fn(sql2);
    } finally {
      await sql2.end({ timeout: 5 }).catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
