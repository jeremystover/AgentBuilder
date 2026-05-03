import { z } from "zod";
import { recipientQueries } from "../../lib/db";
import type { Env } from "../../types";

export const ManageDigestRecipientsInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("add"), email: z.string().email() }),
  z.object({ action: z.literal("remove"), email: z.string().email() }),
]);

export type ManageDigestRecipientsInput = z.infer<typeof ManageDigestRecipientsInput>;

export async function manageDigestRecipients(input: ManageDigestRecipientsInput, env: Env) {
  switch (input.action) {
    case "list": {
      const recipients = await recipientQueries.list(env.DB);
      return { recipients, count: recipients.length };
    }
    case "add": {
      await recipientQueries.add(env.DB, input.email);
      return { added: input.email.toLowerCase() };
    }
    case "remove": {
      await recipientQueries.remove(env.DB, input.email);
      return { removed: input.email.toLowerCase() };
    }
  }
}
