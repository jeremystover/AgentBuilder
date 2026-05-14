import postgres from 'postgres';
import type { Env } from '../types';

export type Sql = ReturnType<typeof postgres>;

/**
 * Open a short-lived Postgres connection through Hyperdrive. Callers are
 * responsible for `await sql.end({ timeout: 5 })` at the end of the
 * request — Workers don't pool connections across requests.
 *
 * Neon auto-suspend can drop the first connection with a transient
 * "Network connection lost" error. The first query through the returned
 * client is retried once after a 2s wait on network/connection errors.
 */
export function db(env: Env): Sql {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false,
  });
  let firstQuery = true;
  return new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      const run = () => Reflect.apply(target, thisArg, args);
      if (!firstQuery) return run();
      firstQuery = false;
      const pending = run();
      const origThen = pending.then.bind(pending);
      pending.then = (onFulfilled: unknown, onRejected: unknown) =>
        origThen(onFulfilled, (err: unknown) => {
          const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
          if (!msg.includes('network') && !msg.includes('connection')) {
            if (typeof onRejected === 'function') return onRejected(err);
            throw err;
          }
          return new Promise<void>(resolve => setTimeout(resolve, 2000))
            .then(() => run().then(onFulfilled, onRejected));
        });
      return pending;
    },
  });
}
