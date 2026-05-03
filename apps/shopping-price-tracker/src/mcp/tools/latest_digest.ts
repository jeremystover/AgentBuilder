import { z } from "zod";
import { digestRunQueries } from "../../lib/db";
import type { Env } from "../../types";

export const LatestDigestInput = z.object({
  include_html: z.boolean().optional().default(false),
});

export type LatestDigestInput = z.infer<typeof LatestDigestInput>;

export async function latestDigest(input: LatestDigestInput, env: Env) {
  const run = await digestRunQueries.latest(env.DB);
  if (!run) return { digest: null };
  const view = {
    id: run.id,
    ran_at: run.ran_at,
    item_count: run.item_count,
    email_status: run.email_status,
    email_error: run.email_error,
    summary_md: run.summary_md,
    ...(input.include_html ? { summary_html: run.summary_html } : {}),
  };
  return { digest: view };
}
