import type { Env } from '../types';
import { jsonOk, jsonError } from '../types';
import { runEmailSync, getEmailStatus, VENDORS } from '../lib/email-sync';
import type { VendorHint } from '../lib/email-matchers/match';

function isVendor(v: string): v is VendorHint {
  return (VENDORS as readonly string[]).includes(v);
}

export async function handleGmailSyncAll(_req: Request, env: Env): Promise<Response> {
  try {
    const out = await runEmailSync(env);
    return jsonOk(out);
  } catch (err) {
    return jsonError(`gmail sync failed: ${String(err)}`, 500);
  }
}

export async function handleGmailSyncVendor(_req: Request, env: Env, vendor: string): Promise<Response> {
  if (!isVendor(vendor)) return jsonError(`unknown vendor: ${vendor}`, 400);
  try {
    const out = await runEmailSync(env, [vendor]);
    return jsonOk(out);
  } catch (err) {
    return jsonError(`gmail sync failed: ${String(err)}`, 500);
  }
}

export async function handleGmailStatus(_req: Request, env: Env): Promise<Response> {
  try {
    return jsonOk(await getEmailStatus(env));
  } catch (err) {
    return jsonError(`gmail status failed: ${String(err)}`, 500);
  }
}
