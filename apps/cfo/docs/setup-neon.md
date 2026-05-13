# Neon + Hyperdrive setup

One-time setup before the CFO worker can serve requests. Manual steps —
the dashboard work isn't scripted yet.

## 1. Create the Neon project

1. Go to <https://neon.tech> and create a project named `family-finance`.
2. Choose the AWS region closest to Cloudflare's primary worker region
   you'll be deploying to (us-east-1 if unsure).
3. From the project dashboard, copy the **pooled** connection string. It
   looks like:
   ```
   postgres://USER:PASSWORD@ep-xxxx-pooler.us-east-1.aws.neon.tech/family_finance?sslmode=require
   ```

## 2. Create the Hyperdrive configuration

1. Cloudflare Dashboard → **Workers & Pages** → **Hyperdrive** → **Create
   configuration**.
2. Name it `cfo-db`.
3. Paste the Neon connection string from step 1.
4. After creation, copy the generated Hyperdrive ID (a hex string).

## 3. Wire it into wrangler.toml

Open `apps/cfo/wrangler.toml` and paste the Hyperdrive ID:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<paste-here>"
```

## 4. Run the schema migration

Neon uses standard Postgres — `wrangler d1 migrations apply` is **not**
applicable here. Run the SQL directly via either method:

### Option A — `psql`

```bash
psql "<neon-connection-string>" -f apps/cfo/migrations/0001_initial.sql
```

### Option B — Neon SQL editor

1. Neon dashboard → SQL Editor for the `family-finance` project.
2. Paste the contents of `apps/cfo/migrations/0001_initial.sql`.
3. Run.

## 5. Set worker secrets

```bash
cd apps/cfo
wrangler secret put WEB_UI_PASSWORD
wrangler secret put EXTERNAL_API_KEY
wrangler secret put MCP_HTTP_KEY
wrangler secret put TELLER_APPLICATION_ID
# ANTHROPIC_API_KEY is managed via the fleet secrets store.
```

## 6. Verify

After `wrangler deploy`:

```bash
curl https://cfo.<account>.workers.dev/health
# → { "status": "ok", "app": "cfo", "db": "connected", "timestamp": "..." }
```
