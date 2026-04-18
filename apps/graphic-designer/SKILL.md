# Graphic Designer

**Purpose.** Designs and produces visual artifacts — Google Slides decks from templates, Cloudflare Pages websites, logos + brand guides, image/icon sourcing, and brand-compliance audits on Docs/Slides.

This is an **app-agent**: it serves a UI at `/` (logo concept gallery, site preview, compliance reports) and an API at `/api/*`, backed by a Durable Object for stateful design sessions.

## When to call me
- "Build a pitch deck from this outline using my template"
- "Design a logo for my new company"
- "Build a landing page and deploy it to Cloudflare Pages"
- "Find me icons/images that match our brand style"
- "Check if this Google Doc follows our brand guidelines"
- "Create a brand style guide to match this logo"
- "Iterate on logo concept #3 — make it more minimal"
- "Export this logo to Canva"

## Non-goals
- Print design, packaging, or video/motion graphics (out of scope v1)
- Long-form copywriting or content strategy (user provides the outline)
- Calendar, tasks, goals, or stakeholder management (that's Chief of Staff)
- Financial accounting, bookkeeping, or tax work (that's CFO)
- Building or modifying other agents (that's Agent Builder)
- Persistent article/knowledge ingestion (that's Research Agent)
- Dynamic web apps with backends — this builds static Cloudflare Pages sites only
- Guest booking or property management (that's Guest Booking)

> **Chief of Staff boundary:** Chief of Staff may read a Google Doc for planning context via `read_content`. Graphic Designer *audits* Docs/Slides for brand compliance and *produces* Slides decks. "Read this doc before my meeting" -> Chief of Staff. "Check if this doc follows brand guidelines" -> Graphic Designer.

## Tools (MCP surface — POST /mcp)

All 11 tools are available via the standard MCP endpoint and via POST /chat.

| Tool | Tier | Description |
|---|---|---|
| `analyze_template` | default | Inspect a Google Slides template deck; map each master/layout -> slot types (title, bullets, image, quote, big-number), text capacity, and best-fit content intents. Stores analysis in D1 for reuse. |
| `plan_presentation` | deep | Given content outline + analyzed template + optional brand guide, propose slide-by-slide breakdown: story arc, layout per slide, text allocation, image/icon needs, speaker-notes beats. Returns a reviewable plan for user approval. |
| `build_presentation` | default | Execute an approved plan: duplicate slides from template, populate text (auto-resize/reposition), call `search_media` for each image/icon slot, insert media, write speaker notes. Emits a Google Drive URL. |
| `search_media` | fast | Unified image/icon search constrained by style-guide spec (palette, mood, style). Sources: Unsplash (photos), Pexels (photos), Iconify (200k+ icons), OpenAI gpt-image-1 (AI-generated fallback). Returns ranked candidates with preview URLs. |
| `check_brand_compliance` | default | Audit a Google Doc or Slides file against a stored brand style guide (colors, fonts, logo usage, spacing, tone). Produces a report with specific violations + suggested fixes. |
| `plan_site` | deep | Given content outline + brand guide, proposes information architecture (pages), section blocks per page, visual language (type scale, grid, color tokens), and asset needs. Reviewable before build. |
| `build_and_deploy_site` | default | Generates static HTML/CSS (Tailwind), sources media via `search_media`, deploys to Cloudflare Pages via Direct Upload API. Accepts iteration feedback and re-deploys. Returns live URL. |
| `generate_logo_concepts` | deep | From a design brief (gathered via structured chat interview: industry, audience, mood words, color prefs, inspirations, names-to-avoid), produces 6-10 distinct logo concepts spanning mark/wordmark/combo and literal/abstract. Uses OpenAI gpt-image-1. Returns concept gallery. |
| `finalize_logo_package` | default | From a chosen concept, produces the full export set: SVG master, PNG at standard sizes (512/1024/2048), monochrome + reversed variants, favicon.ico, social avatars (LinkedIn/X/Instagram). Drafts a matching brand style guide (palette, type pairings, voice, spacing rules). Saves to R2 + Google Drive folder. |
| `manage_brand_assets` | fast | CRUD for stored brand guides, template decks, logo packages, and completed project history. Lets other tools reference `brand_id: "acme"` without re-uploading. |
| `canva_export` | default | Export a logo package or brand assets to Canva via the Canva Connect API. Creates a Canva Brand Kit with colors, fonts, and logo files. |

## REST endpoints
- `POST /api/chat` — conversational design session (logo interview, deck planning)
- `GET /api/projects` — list design projects (decks, sites, logos)
- `GET /api/projects/:id` — project details with preview URLs
- `GET /api/concepts/:projectId` — logo concept gallery for a project
- `POST /api/concepts/:projectId/select` — select concepts for next iteration round

## Integrations
- **Google Drive / Slides / Docs API** — via `@agentbuilder/auth-google` (fleet OAuth). Read templates, create presentations, audit docs.
- **Cloudflare Pages Direct Upload** — deploy static sites using `CLOUDFLARE_API_TOKEN` (fleet secret).
- **Unsplash API** — stock photos. Secret: `UNSPLASH_ACCESS_KEY`.
- **Pexels API** — stock photos. Secret: `PEXELS_API_KEY`.
- **Iconify API** — 200k+ open-source icons. No key required.
- **OpenAI API** — `gpt-image-1` for logo concepts and AI-generated images. Secret: `OPENAI_API_KEY`.
- **Canva Connect API** — Brand Kit export. Secret: `CANVA_API_KEY`.

## Shared packages
- `@agentbuilder/core` — logging, utilities
- `@agentbuilder/llm` — model tier abstraction (deep/default/fast)
- `@agentbuilder/auth-google` — OAuth token vault for Google APIs

## Cloudflare resources
- **D1:** `graphic-designer-db` — tables: `brand_guides`, `templates`, `template_layouts`, `projects`, `logo_concepts`, `site_deployments`, `compliance_reports`
- **R2:** `graphic-designer-assets` — logo exports, generated images, site snapshots, uploaded brand files
- **Durable Object:** `GraphicDesignerDO` — stateful chat/design sessions (logo interview state, deck planning iterations)
- **Assets:** SPA for concept gallery, site preview, compliance report viewer

## Notes
- Model tiers: `deep` (Opus) for creative reasoning (plans, concepts), `default` (Sonnet) for execution (build, audit), `fast` (Haiku) for search ranking and asset CRUD
- Logo interview is a structured chat flow in the DO — session persists `brief` state (industry, audience, mood words, color preferences, names-to-avoid, inspirations) across turns
- The seed template deck (Google Slides ID `1QIpHG7Bj_XcYkZer9b5Fydv0OGEUqXHvP_W0iWMVJaY`) is registered as the default template on first run
- 11 tools slightly exceeds the fleet ~10 guideline; the routing prompt explicitly delineates Canva export as a terminal post-production step to keep selection accuracy high
