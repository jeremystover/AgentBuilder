/**
 * Daily cron handler. Builds + renders + emails the digest, persists the
 * digest_run row regardless of email success.
 */

import { digestRunQueries, recipientQueries } from "../lib/db";
import { newId } from "../lib/ids";
import { nowIso } from "../lib/time";
import type { Env } from "../types";
import { buildDigest } from "../digest/build";
import { renderDigest } from "../digest/render";
import { sendDigestEmail } from "../digest/email";

export async function runDailyDigest(env: Env): Promise<void> {
  console.log("[cron/daily] start");
  const built = await buildDigest(env);
  const rendered = renderDigest(built);

  const runId = newId();
  await digestRunQueries.insert(env.DB, {
    id: runId,
    ran_at: built.ranAt,
    item_count: built.itemCount,
    email_status: "pending",
    email_error: null,
    summary_md: rendered.text,
    summary_html: rendered.html,
  });

  const recipients = (await recipientQueries.list(env.DB)).map((r) => r.email);
  if (recipients.length === 0) {
    await digestRunQueries.updateStatus(env.DB, runId, "skipped", "no recipients configured");
    console.warn("[cron/daily] no recipients — skipping email");
    return;
  }

  const result = await sendDigestEmail(env, rendered, recipients);
  if (result.sent > 0 && result.failed === 0) {
    await digestRunQueries.updateStatus(env.DB, runId, "sent", null);
  } else if (result.sent > 0) {
    await digestRunQueries.updateStatus(env.DB, runId, "sent", `partial: ${result.failed} failed`);
  } else {
    await digestRunQueries.updateStatus(
      env.DB,
      runId,
      "failed",
      result.error ?? "unknown send failure",
    );
  }
  console.log(`[cron/daily] ranAt=${built.ranAt} sent=${result.sent} failed=${result.failed}`);
  // Touch nowIso to keep it imported even if unused once.
  void nowIso;
}
