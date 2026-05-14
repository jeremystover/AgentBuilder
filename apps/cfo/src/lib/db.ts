import postgres from 'postgres';
import type { Env } from '../types';

export type Sql = ReturnType<typeof postgres>;

/**
 * Open a short-lived Postgres connection through Hyperdrive. Callers are
 * responsible for `await sql.end({ timeout: 5 })` at the end of the
 * request — Workers don't pool connections across requests.
 */
export function db(env: Env): Sql {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
  });
}
