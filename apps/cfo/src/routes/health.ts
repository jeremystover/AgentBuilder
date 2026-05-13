import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { db } from '../lib/db';

export async function handleHealth(_req: Request, env: Env): Promise<Response> {
  const sql = db(env);
  try {
    await sql`SELECT 1`;
    return jsonOk({
      status: 'ok',
      app: 'cfo',
      db: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return jsonError(`db connection failed: ${String(err)}`, 503);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
