# Paywall ingestion plan

How Research Agent pulls in content from sites where you have a paid
subscription: Wired, Charter, Medium. None of these expose a clean OAuth
content API, so "auth" here means storing your subscriber session and
replaying it on fetch.

## TL;DR per source

| Source  | Discovery | Auth method | Path |
|---|---|---|---|
| **Charter**  | Newsletter email arrives in your inbox | None for the email path; cookies for archive replay | **Email ingestion** (built) → `email/handler.ts` newsletter mode. Optional cookie replay against `charterworks.com` for back-issues. |
| **Medium**   | Member RSS at `https://medium.com/feed/@<handle>` lists URLs | `sid` cookie from a logged-in session | New `medium-watcher` worker. Fetch RSS → for each URL, refetch with cookie to get the full member-only body. |
| **Wired**    | Section RSS or sitemap | Condé Nast session cookie | New `wired-watcher` worker. Same shape as `medium-watcher`. |

All three end up at `research-agent/ingest` with pre-fetched content, the
same way `linkedin-watcher` already operates.

## Building blocks (shipped in this branch)

### `@agentbuilder/crypto`
Generic AES-256-GCM helpers (`encrypt`, `decrypt`, `importKey`,
`generateKey`, `exportKey`) extracted from `@agentbuilder/auth-google` so
multiple packages can share them without one depending on the other.

### `@agentbuilder/credential-vault`
Encrypted, agent-scoped storage for opaque credentials — cookies, session
JWTs, API keys, basic-auth blobs.

```ts
import { D1CredentialVault } from '@agentbuilder/credential-vault';

const vault = new D1CredentialVault({ db: env.CREDS_DB, encryptionKey: kek });

await vault.put({
  agentId:   'wired-watcher',
  accountId: 'jeremy@example.com',
  provider:  'wired',
  kind:      'cookie',
  value:     'wp_user_token=...; CN_SubID=...',
  metadata:  { domain: '.wired.com', uaHint: 'Mozilla/5.0 ...' },
  expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const cred = await vault.get({
  agentId: 'wired-watcher', accountId: 'jeremy@example.com',
  provider: 'wired',         kind: 'cookie',
});
```

Schema in `packages/credential-vault/src/schema.ts`. The composite primary
key `(agent_id, account_id, provider, kind)` plus the vault class's
agent-scoped reads make a cross-agent leak require bypassing the class
entirely — visible in code review.

### Research Agent newsletter ingestion
`apps/research-agent/src/email/handler.ts` now routes inbound emails two
ways:

1. **Newsletter mode** — when `message.from` matches a key in
   `env.NEWSLETTER_SENDERS`, the email body is ingested as the article
   (using the existing pre-fetched-content path of `ingestUrl`). No URL
   fetch, so paywalled URLs don't return teasers.
2. **URL-extraction mode** (default, unchanged) — for forwarded emails
   that aren't newsletters, harvest URLs and ingest each.

Configure with a Wrangler secret:

```bash
wrangler secret put NEWSLETTER_SENDERS --name research-agent
# Value (paste this JSON):
# {
#   "newsletter@charterworks.com": { "provider": "charter" },
#   "hello@stratechery.com":       { "provider": "stratechery" }
# }
```

Then point your subscription to the email-routing address you've already
wired up to research-agent (or set up a Cloudflare Email Worker route to
forward there). For newsletters that don't deliver to the inbound address
directly, set up a forwarding rule in Gmail/Fastmail.

## Per-source designs

### Charter — built today via email; cookie path optional later

**Why email first.** Charter sends the full newsletter to subscribers.
You're paying for the email, not the website. Forwarding it to
research-agent is robust, ToS-clean, and survives any future redesign.

**Setup checklist:**
1. Add `"newsletter@charterworks.com"` to `NEWSLETTER_SENDERS` (verify the
   exact From: address from a recent issue).
2. In your inbox, set up a filter that auto-forwards Charter emails to
   research-agent's inbound address.
3. Done. The body becomes the article body; subject becomes the title;
   the "View in browser" link in the body becomes the canonical URL.

**Cookie-replay alternative (later, if you want archives):** Charter is a
Ghost-hosted site. Logged-in subscribers can hit
`https://charterworks.com/<post-slug>/` directly; their auth is a
`ghost-members-ssr` cookie. If you want to bulk-ingest the back catalog,
add a `charter-watcher` worker that:
- Fetches `https://charterworks.com/sitemap.xml` for the URL list
- Fetches each URL with the cookie from the credential vault
- Forwards extracted content to research-agent

### Medium — cookie replay against member RSS

Medium gives logged-in members a personal RSS feed at
`https://medium.com/feed/@<handle>` and a feed for their following list.
The RSS items are short — full member-only bodies require the `sid`
cookie from a logged-in session.

**Worker layout (`apps/medium-watcher`):**
- KV `MEDIUM_STATE` — watchlist (followed handles, list URLs) + dedup
  keyed by Medium's stable post id
- Cron daily (e.g. `0 13 * * *`)
- For each watched feed:
  1. Fetch the member RSS (no auth needed for the feed itself)
  2. For each `<item>`, fetch the article URL with the `sid` cookie from
     `credential-vault` (`agentId='medium-watcher'`, `provider='medium'`,
     `kind='cookie'`)
  3. Run the existing `extractContent` pipeline (HTMLRewriter is fine on
     Medium's markup) to get clean body text
  4. POST to `research-agent/ingest` with pre-fetched `content` and the
     `INTERNAL_SECRET` bearer

**Cookie acquisition:**
1. Log into medium.com in your browser.
2. DevTools → Application → Cookies → copy `sid` (and `uid`) values.
3. Save with a one-shot CLI: `pnpm tools cred put medium <account> --kind cookie`
   (we'll add this; reuses the vault).

`sid` rotates roughly every 30 days. The vault stores `expiresAt` so the
worker can warn before the cookie dies. There is no automated refresh —
you re-paste when it expires.

### Wired — same shape as Medium

Condé Nast paywall is server-side cookie-based. Section RSS feeds (e.g.
`https://www.wired.com/feed/category/business/rss`,
`https://www.wired.com/feed/tag/<tag>/rss`) are public and contain full
URLs but truncated bodies for paywalled pieces.

**Worker layout (`apps/wired-watcher`):** identical to `medium-watcher`.
The watchlist is RSS feed URLs instead of handles. The cookie blob comes
from the same vault under `provider='wired'`.

**Caveat:** Condé occasionally rotates session IDs and adds bot-detection
challenges. If a fetch returns a challenge HTML instead of the article,
the worker should mark the credential as needing refresh (set
`metadata.needsRefresh=true` in the vault) and skip rather than poison
the knowledge base with junk.

## Cookie acquisition UX

Three options, in order of effort:

1. **Manual paste (v1).** Add a `tools/credentials.ts` CLI:
   ```
   pnpm tools cred put wired jeremy@example.com --kind cookie
   # prompts for the cookie string, stores encrypted
   ```
   Cheapest path to working.

2. **Browser extension (v2).** A tiny extension with permissions for
   `wired.com`, `medium.com`, `charterworks.com` that reads the relevant
   cookies and POSTs to a `research-agent` endpoint. The endpoint
   forwards into the vault. Reduces error rate on copy-paste.

3. **Headless login (v3).** Run a Browserless or Cloudflare Browser
   Rendering session that logs in with stored username/password and
   harvests the cookie. Brittle for sites with MFA / captcha; defer
   until 1 and 2 prove insufficient.

## Risk and ToS

- **Personal scope only.** All three paths replay your own paid session,
  with the content stored in your private knowledge base. Don't share
  research-agent output externally without re-checking each source's
  republication terms.
- **Wired / Condé Nast** ToS prohibits automated scraping. Personal
  archival is grey but enforceable; keep the watchlist small and the
  poll cadence daily, not minutely.
- **Medium** ToS allows reading via your account; automated fetching of
  member-only content from a logged-in account is in the same grey area.
- **Charter** is the cleanest of the three because the email path uses
  content they actively delivered to you.
- **No fanout.** Don't repost extracted content to public surfaces. The
  research agent's `/lab` UI is single-user gated by `WEB_UI_PASSWORD`.

## Build order recommendation

1. **Done in this branch:** crypto split, credential vault, newsletter
   email ingestion. Wire up the Charter email forward and verify a real
   issue lands as an article in research-agent.
2. **Next:** small `tools/credentials.ts` CLI to put/get/delete vault
   entries from the dev machine.
3. **Then:** `medium-watcher` worker (cleanest cookie-replay target;
   member RSS gives a clean URL list).
4. **Finally:** `wired-watcher`, after Medium proves the pattern.
