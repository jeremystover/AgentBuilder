# =============================================================================
# Makefile — jsstover Cloudflare Workers
# Default target is agent-builder. Override with: make deploy WORKER=cfo
# =============================================================================

WORKER      ?= agent-builder
COMMIT_MSG  ?= fix

# Worker → URL map (used for smoke tests)
URL_agent-builder            := https://agent-builder.jsstover.workers.dev
URL_cfo                      := https://cfo.jsstover.workers.dev
URL_chief-of-staff           := https://chief-of-staff.jsstover.workers.dev
URL_research-agent           := https://research-agent.jsstover.workers.dev
URL_graphic-designer         := https://graphic-designer.jsstover.workers.dev
URL_shopping-price-tracker   := https://shopping-price-tracker.jsstover.workers.dev
URL_termination-documentation := https://termination-documentation.jsstover.workers.dev

WORKER_URL := $(URL_$(WORKER))

# =============================================================================
# Core targets
# =============================================================================

## Deploy the current worker (wrangler only, no git)
.PHONY: deploy
deploy:
	@echo "→ Deploying $(WORKER)..."
	npx wrangler deploy --config apps/$(WORKER)/wrangler.toml

## Stream live logs from the current worker (Ctrl-C to stop)
.PHONY: logs
logs:
	@echo "→ Tailing logs for $(WORKER)..."
	npx wrangler tail $(WORKER) --format pretty

## Smoke test the current worker's MCP endpoint
.PHONY: test
test:
	@echo "→ Testing $(WORKER) at $(WORKER_URL)/mcp ..."
	@curl -s -X POST $(WORKER_URL)/mcp \
		-H "Content-Type: application/json" \
		-d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
	| jq 'if .result then "✅ PASS: \(.result.tools | length) tools returned" elif .error then "❌ FAIL: \(.error.message)" else "❌ FAIL: unexpected response" end' -r

## Full loop: commit → PR → auto-merge → wait for CI → deploy → test
## Usage: make fix-and-ship WORKER=cfo COMMIT_MSG="fix auth header"
.PHONY: fix-and-ship
fix-and-ship:
	@echo "→ Committing..."
	git add -A
	git commit -m "fix: $(COMMIT_MSG)"
	git push
	@echo "→ Opening PR and auto-merging..."
	gh pr create --fill
	gh pr merge --squash --auto
	@echo "→ Waiting for CI to complete..."
	gh run watch
	@echo "→ Deploying $(WORKER)..."
	$(MAKE) deploy WORKER=$(WORKER)
	@echo "→ Running smoke test..."
	$(MAKE) test WORKER=$(WORKER)

# =============================================================================
# Per-worker shortcuts
# =============================================================================

.PHONY: deploy-agent-builder deploy-cfo deploy-chief-of-staff \
        deploy-research-agent deploy-graphic-designer \
        deploy-shopping-tracker deploy-termdocs

deploy-agent-builder:
	$(MAKE) deploy WORKER=agent-builder

deploy-cfo:
	$(MAKE) deploy WORKER=cfo

deploy-chief-of-staff:
	$(MAKE) deploy WORKER=chief-of-staff

deploy-research-agent:
	$(MAKE) deploy WORKER=research-agent

deploy-graphic-designer:
	$(MAKE) deploy WORKER=graphic-designer

deploy-shopping-tracker:
	$(MAKE) deploy WORKER=shopping-price-tracker

deploy-termdocs:
	$(MAKE) deploy WORKER=termination-documentation

## Test all workers in sequence
.PHONY: test-all
test-all:
	@for w in agent-builder cfo chief-of-staff research-agent graphic-designer shopping-price-tracker termination-documentation; do \
		$(MAKE) test WORKER=$$w; \
	done

# =============================================================================
# Auth check (run this if wrangler or gh start failing)
# =============================================================================

.PHONY: auth-check
auth-check:
	@echo "→ Checking Wrangler auth..."
	@npx wrangler whoami && echo "✅ Wrangler OK" || echo "❌ Run: npx wrangler login"
	@echo "→ Checking GitHub CLI auth..."
	@gh auth status && echo "✅ GitHub CLI OK" || echo "❌ Run: gh auth login"

# =============================================================================
# Help
# =============================================================================

.PHONY: help
help:
	@echo ""
	@echo "Usage: make <target> [WORKER=name] [COMMIT_MSG='description']"
	@echo ""
	@echo "Core targets:"
	@echo "  deploy          Deploy WORKER (default: agent-builder)"
	@echo "  logs            Stream live logs from WORKER"
	@echo "  test            Smoke test WORKER's MCP endpoint"
	@echo "  fix-and-ship    Full loop: commit → PR → merge → deploy → test"
	@echo "  test-all        Smoke test every worker"
	@echo "  auth-check      Verify wrangler + gh CLI are authenticated"
	@echo ""
	@echo "Per-worker shortcuts:"
	@echo "  deploy-agent-builder, deploy-cfo, deploy-chief-of-staff,"
	@echo "  deploy-research-agent, deploy-graphic-designer,"
	@echo "  deploy-shopping-tracker, deploy-termdocs"
	@echo ""
	@echo "Examples:"
	@echo "  make fix-and-ship WORKER=cfo COMMIT_MSG='fix tax year init'"
	@echo "  make logs WORKER=research-agent"
	@echo "  make test WORKER=chief-of-staff"
	@echo ""
