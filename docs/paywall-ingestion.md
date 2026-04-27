# Paywall ingestion

How Research Agent pulls in content from sites where you have a paid
subscription: Wired, Charter, Medium. None of these expose a clean OAuth
content API, so "auth" here means storing your subscriber session and
replaying it on fetch.

## TL;DR per source

| Source | Discovery | Auth | Path |
|---|---|---|---|
| **Charter** | Newsletter email arrives in your inbox | None for the email path | Email-mode ingestion in `research-agent/email/handler.ts` (newsletter senders configured via `NEWSLETTER_SENDERS`). |
| **Medium**  | Member / publication / tag RSS | `sid` cookie from a logged-in session | `apps/medium-watcher` — daily cron polls each feed, refetches each new URL with the cookie, extracts the article, forwards to research-agent. |
| **Wired**   | Section / tag RSS | Condé Nast session cookie (`wp_user_token`, `CN_SubID`, …) | `apps/wired-watcher` — same shape as medium-watcher, with a higher paywall heuristic to absorb Wired's longer truncated previews + bot-challenge HTML. |

All three end at `research-agent/ingest` with pre-fetched content, the
same way `linkedin-watcher` already operates.

## Shared building blocks

### `@agentbuilder/crypto`
Generic AES-256-GCM helpers (`encrypt`, `decrypt`, `importKey`,
`generateKey`, `exportKey`). `auth-google` re-exports the same primitives
as `encryptToken`/`decryptToken` for backward compatibility.

### `@agentbuilder/credential-vault`
Encrypted, agent-scoped storage for opaque credentials — cookies, session
JWTs, API keys, basic-auth blobs.

```ts
import { D1CredentialVault } from '@agentbuilder/credential-vault';

const vault = new D1CredentialVault({ db: env.VAULT_DB, encryptionKey: kek });

await vault.put({
  agentId:   'wired-watcher',
  accountId: 'default',
  provider:  'wired',
  kind:      'cookie',
  value:     'wp_user_token=...; CN_SubID=...',
  metadata:  { domain: '.wired.com' },
  expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
```

Schema in `packages/credential-vault/src/schema.ts`. Reads are scoped by
`agentId`; the composite primary key `(agent_id, account_id, provider,
kind)` plus the vault class's agent gate make a cross-agent leak require
bypassing the class entirely (visible in code review).

The package also exports `mountCredentialsApi` — a drop-in REST surface
(`GET / PUT / DELETE /:account/:provider/:kind`, plus `GET /` to list)
that any worker can mount on its vault. Both medium-watcher and
wired-watcher mount it under `/credentials`.

### `@agentbuilder/extract-article`
Pure HTML → `ExtractedArticle` (title / author / publishedAt / fullText /
canonicalUrl) using HTMLRewriter, JSON-LD, og: meta, and a `<article>`
body walk. Used by both watchers after they've replayed the cookie.

### `tools/credentials.ts` (`pnpm cred`)
Thin client over `mountCredentialsApi`. Per-agent endpoints + bearer
tokens live in `~/.agentbuilder/credentials.json`:

```json
{
  "medium-watcher": { "url": "https://medium-watcher.you.workers.dev", "apiKey": "..." },
  "wired-watcher":  { "url": "https://wired-watcher.you.workers.dev",  "apiKey": "..." }
}
```

Commands:

```
pnpm cred genkey                                                    # 32-byte AES-256-GCM KEK
pnpm cred list   <agent> [--provider X] [--account Y]
pnpm cred get    <agent> <account> <provider> <kind>
pnpm cred put    <agent> <account> <provider> <kind>                # value via stdin
pnpm cred delete <agent> <account> <provider> <kind>
```

Values are read from stdin so cookies don't land in shell history.

## Per-source

### Charter — email mode

Charter sends the full newsletter to subscribers. You're paying for the
email, not the website, so forwarding into research-agent is robust,
ToS-clean, and survives any future redesign.

**How it works.** `research-agent/src/email/handler.ts` routes inbound
emails two ways:

1. **Newsletter mode** — when `message.from` matches a key in
   `env.NEWSLETTER_SENDERS`, a minimal MIME parser pulls the
   `text/plain` (or stripped `text/html`) body and ingests it as the
   article. No URL fetch, so paywalled "View in browser" links don't
   matter. The "View in browser" link, when present, becomes the
   canonical URL for dedup.
2. **URL-extraction mode** (default, unchanged) — for forwarded emails
   that aren't newsletters, harvest URLs and ingest each.

**Setup.**

```bash
wrangler secret put NEWSLETTER_SENDERS --name research-agent
# JSON value:
# {
#   "newsletter@charterworks.com": { "provider": "charter" },
#   "hello@stratechery.com":       { "provider": "stratechery" }
# }
```

Then forward Charter emails to research-agent's inbound address
(Cloudflare Email Worker route, or a Gmail/Fastmail filter). Verify the
exact From: from a recent issue before configuring.

**Cookie-replay alternative (later, if you want archives).** Charter is
Ghost-hosted; logged-in subscribers can hit `https://charterworks.com/<post-slug>/`
directly with a `ghost-members-ssr` cookie. To bulk-ingest back issues,
clone `medium-watcher` → `charter-watcher`, point it at
`https://charterworks.com/sitemap.xml` for URL discovery, and use
`provider='charter'` in the vault.

### Medium — `apps/medium-watcher`

**Pipeline.** Daily cron at 14:00 UTC:
1. Load the cookie from the vault (one read per run).
2. For each watched feed (`https://medium.com/feed/@<handle>` etc.),
   fetch the RSS unauthenticated.
3. Diff against `seen:{slug}` KV.
4. For each new item, GET the article URL with `Cookie: <vault value>`
   and a Safari UA, run `extractArticle(html)`, and POST `{ url, content,
   title, author, published_at, source_id }` to `research-agent/ingest`
   with `INTERNAL_SECRET`.
5. Body < 800 chars → `looksPaywalled = true`. Mark seen so we don't
   loop; operator refreshes the cookie and re-runs to pick up missed
   items.

**Cookie acquisition.** DevTools → Application → Cookies on
`medium.com` → copy `sid` (and `uid`) as `name1=value1; name2=value2`.
Then `pnpm cred put medium-watcher default medium cookie` and paste via
stdin. `sid` rotates roughly every 30 days; set `--expires-at` so future
tooling can warn before expiry.

### Wired — `apps/wired-watcher`

Same shape as medium-watcher with three differences:
- Watchlist holds Wired RSS URLs (`https://www.wired.com/feed/rss`,
  `…/feed/category/business/rss`, `…/feed/tag/<tag>/rss`).
- Cron offset to `30 14 * * *` so it doesn't run concurrently with
  medium-watcher.
- Paywall heuristic at 1200 chars (vs 800) to catch Wired's longer
  truncated previews and the ~600-char Cloudflare/Akamai bot-challenge
  HTML the site occasionally serves.

**Cookie acquisition.** DevTools → Application → Cookies on
`wired.com` → copy the relevant Condé cookies (`wp_user_token`,
`CN_SubID`, plus any others) as a single header value. Then `pnpm cred
put wired-watcher default wired cookie`.

**Bot-challenge caveat.** When `paywalled` counts climb in cron logs and
your cookie is fresh, Wired probably served a JS challenge. The
heuristic catches it the same way as a stale cookie — re-paste the
cookie after a clean browser fetch and re-run.

## Cookie acquisition UX

Three options, in order of effort. Today's tooling implements (1).

1. **Manual paste (shipped).** `pnpm cred put …` reads from stdin and
   posts to the watcher's `/credentials` endpoint. Cheapest path to
   working.
2. **Browser extension (future).** A tiny extension with permissions for
   `wired.com`, `medium.com`, `charterworks.com` that reads the relevant
   cookies and POSTs into the same `/credentials` endpoint. Reduces
   copy-paste error rate.
3. **Headless login (further future).** Cloudflare Browser Rendering
   session that logs in with stored credentials and harvests the cookie.
   Brittle against MFA / captcha — defer until (1) and (2) prove
   insufficient.

## Risk and ToS

- **Personal scope only.** All three paths replay your own paid session
  into your own private knowledge base. Don't share Research Agent
  output externally without re-checking each source's republication
  terms.
- **Wired / Condé Nast** ToS prohibits automated scraping. Personal
  archival is grey but enforceable. Keep the watchlist small and the
  poll cadence daily.
- **Medium** ToS allows reading via your account; automated fetching of
  member-only content from a logged-in account sits in the same grey
  area.
- **Charter** is the cleanest of the three because the email path uses
  content they actively delivered to you.
- **No fanout.** Don't repost extracted content to public surfaces.
  Research Agent's `/lab` UI is single-user gated by `WEB_UI_PASSWORD`.

## Verification checklist

For each watcher, after running the SKILL.md setup commands:

1. `curl /health` returns `{ ok: true, watching: 0 }`.
2. `pnpm cred put <agent> default <provider> cookie` round-trips through
   `pnpm cred get` (returns the same value).
3. `POST /watch` adds a feed; `GET /watch` lists it.
4. `POST /run` returns a result with `processed > 0` and
   `cookieMissing: false`. Tail wrangler logs:
   ```
   wrangler tail medium-watcher --format=pretty
   wrangler tail wired-watcher  --format=pretty
   ```
5. Search Research Agent for one of the article titles — it should come
   back as an indexed article with the right author + publish date.
6. If `paywalled > 0`, check the URL manually in your browser to confirm
   you actually have access; if you do, refresh the cookie and re-run.

For Charter, the equivalent is: forward a single newsletter to
research-agent's inbound address, then search Research Agent for a
phrase from that issue.
