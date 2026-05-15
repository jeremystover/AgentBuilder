# CLAUDE.md
Behavioral guidelines for Claude Code sessions working in this repo. Fleet conventions (rules about agents, packages, scaffolding) live in `AGENTS.md` — read both.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgment.

---

## 1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

---

## 2. Simplicity First
**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

---

## 3. Surgical Changes
**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

---

## 4. Goal-Driven Execution
**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## 5. Deploy Workflow
**Fix → commit → merge → deploy → test. No human gate.**

After completing any change that should go live, run this sequence:

```bash
# 1. Commit
git add -A
git commit -m "fix: <description>"
git push

# 2. Open and immediately auto-merge PR (no review required)
gh pr create --fill
gh pr merge --squash --auto

# 3. Wait for GitHub Actions deploy to complete
gh run watch

# 4. Run smoke test (see §6)
make test
```

**Do not stop and ask for merge approval.** The workflow is intentionally no-gate. If the smoke test fails after deploy, diagnose using logs (see §6) and loop.

---

## 6. Cloudflare Auth & Debugging

### Auth setup (one-time, in the developer's local terminal — not Claude Code's job)
Wrangler and GitHub CLI credentials are stored outside the repo:
- `~/.wrangler/` — Wrangler OAuth token (set via `wrangler login`)
- `~/.config/gh/` — GitHub CLI token (set via `gh auth login`)

**Never put API tokens in repo files.** GitHub will block them. Cloudflare API tokens for CI/CD live in GitHub repo Settings → Secrets → Actions as `CLOUDFLARE_API_TOKEN`.

### Verifying auth before starting work
```bash
npx wrangler whoami      # should show your Cloudflare account
gh auth status           # should show authenticated to GitHub
```

If either fails, stop and tell the developer — do not attempt to set up credentials yourself.

### Reading logs
Stream live logs from a specific worker while triggering a request:
```bash
npx wrangler tail <worker-name> --format pretty
# e.g.: npx wrangler tail agent-builder --format pretty
```

For recent errors without live streaming:
```bash
npx wrangler tail <worker-name> --format json | head -50
```

### Smoke test
```bash
make test
# or directly:
curl -s -X POST https://agent-builder.jsstover.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' | jq .
```

A successful response has a `result.tools` array. An error response has an `error` key — read it and diagnose before reporting back.

### Debug loop
When something is broken:
1. Run `make test` — read the error response body carefully.
2. If the error is unclear, run `wrangler tail` in one terminal and re-run the test in another.
3. Fix the code. Deploy (`make fix-and-ship` or the sequence in §5). Re-run `make test`.
4. Don't report "it's deployed" — report whether the smoke test passed or failed.

---

## 7. Makefile Targets
These targets are available for common tasks. Prefer them over ad-hoc commands:

```bash
make deploy          # wrangler deploy only (no git)
make logs            # wrangler tail, live stream
make test            # smoke test the MCP endpoint
make fix-and-ship    # commit + PR + merge + deploy + test (pass msg="..." for commit message)
```

If a Makefile target is missing for a repeated task, add it and commit it.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

**Origin:** distilled from Andrej Karpathy's January 2026 observations on LLM coding pitfalls, via the [`andrej-karpathy-skills`](https://github.com/forrestchang/andrej-karpathy-skills) CLAUDE.md.

---

## Runtime agents
The four bolded one-liners above are also exported from `@agentbuilder/llm` as `CORE_BEHAVIORAL_PREAMBLE`. Runtime agents (the AgentBuilder personas and any agent under `apps/*`) should prepend that constant to their system prompt. See `AGENTS.md` rule 10.
