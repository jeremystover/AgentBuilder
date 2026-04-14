# Project: tax-prep

## Stack
- Runtime: Cloudflare Workers (TypeScript)
- Database: D1 (SQLite) — accessed via `env.DB`
- File storage: R2 — accessed via `env.BUCKET`
- Deploy: `npm run deploy` via Wrangler

## Commands
- `npm run dev` — local dev server (hot reload)
- `npm run deploy` — deploy to Cloudflare
- `npm run db:migrate` — run pending DB migrations

## Project Structure
- `src/index.ts` — main Worker entry point, all routing starts here
- `src/routes/` — individual route handlers
- `src/lib/` — shared utilities
- `migrations/` — SQL migration files (named 0001_name.sql, 0002_name.sql)

## Conventions
- All routes return `Response.json()`
- Validate inputs with Zod
- DB migrations go in `/migrations`, never modify the DB directly
- Env vars: use `.dev.vars` locally, Cloudflare dashboard secrets in prod

## DO NOT
- Commit `.dev.vars` (contains secrets)
- Push directly to `main` — use PRs
- Use `any` types in TypeScript
