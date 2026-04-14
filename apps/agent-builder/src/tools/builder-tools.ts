/**
 * Builder-specific tools.
 *
 * The Builder persona is the *planning* half of scaffolding and migration.
 * Actual file writes, git ops, wrangler, pnpm, GitHub API — all of that runs
 * in Claude Code locally via the migrate-agent / scaffold-agent skills,
 * because Cloudflare Workers can't touch a filesystem.
 *
 * So the Builder's toolset is small and read-only:
 *   - list_agents / describe_agent (from shared registry tools) — so it
 *     can inspect the target agent in the registry
 *   - plan_migration: a pure function that takes a migration design and
 *     returns a structured, stepwise checklist for Claude Code to execute
 *
 * The Builder never writes. It produces a plan + a HANDOFF line that the
 * user pastes into Claude Code.
 */

import type { ToolDefinition, ToolHandler } from '@agentbuilder/llm';
import type { MemoryRegistryStore } from '@agentbuilder/registry';
import { buildRegistryTools } from './registry-tools.js';

export interface BuilderToolset {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}

export function buildBuilderTools(store: MemoryRegistryStore): BuilderToolset {
  const base = buildRegistryTools(store);

  const tools: ToolDefinition[] = [
    ...base.tools,
    {
      name: 'plan_migration',
      description:
        'Given a migration design (agent id + source repo + source worker + target worker + port notes), return a structured step-by-step migration plan. Pure function — does not execute anything. Call this once you know the target id and have read the existing registry entry. The output is what Claude Code will actually execute via the migrate-agent skill.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The target agent id in the registry (e.g. "cfo").',
          },
          sourceRepo: {
            type: 'string',
            description: 'GitHub repo of the source agent (e.g. "jeremystover/tax-prep").',
          },
          sourceWorker: {
            type: 'string',
            description: 'Existing Cloudflare worker name (e.g. "tax-prep").',
          },
          targetWorker: {
            type: 'string',
            description: 'New worker name after migration (e.g. "cfo").',
          },
          portNotes: {
            type: 'string',
            description: 'Short free-form notes on what to keep, rewrite, or drop.',
          },
        },
        required: ['id', 'sourceRepo', 'sourceWorker', 'targetWorker'],
        additionalProperties: false,
      },
    },
    {
      name: 'plan_scaffold',
      description:
        'Given an agent id that already exists in the registry (status: draft), return a scaffolding plan: which template to copy, which bindings to create, which secrets to prompt for. Pure function. Claude Code\'s scaffold-agent skill consumes this.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The draft agent id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    ...base.handlers,

    plan_migration: async (input) => {
      const id = String(input.id ?? '').trim();
      const sourceRepo = String(input.sourceRepo ?? '').trim();
      const sourceWorker = String(input.sourceWorker ?? '').trim();
      const targetWorker = String(input.targetWorker ?? '').trim();
      const portNotes = String(input.portNotes ?? '').trim();

      if (!id || !sourceRepo || !sourceWorker || !targetWorker) {
        return {
          error: 'id, sourceRepo, sourceWorker, and targetWorker are all required',
        };
      }

      const entry = await store.getAgent(id);
      if (!entry) {
        return {
          error: `No agent with id "${id}" in the registry. The Architect should upsert the design first.`,
        };
      }

      const targetPath = `apps/${id}`;
      const template = entry.kind === 'app' ? 'app-agent' : 'headless-agent';

      const steps = [
        {
          step: 1,
          title: 'Clone source repo read-only',
          detail: `git clone --depth=1 https://github.com/${sourceRepo}.git /tmp/${id}-source (or use GitHub MCP to read files directly). Do NOT modify the source — it stays deployed as the fallback during parallel-run.`,
        },
        {
          step: 2,
          title: 'Scaffold target from template',
          detail: `Copy .agent-builder/templates/${template}/ to ${targetPath}/. Replace {{AGENT_ID}}, {{AGENT_NAME}}, {{WORKER_NAME}} placeholders with "${id}", "${entry.name}", and "${targetWorker}".`,
        },
        {
          step: 3,
          title: 'Port the skills',
          detail: `For each skill in the registry entry (${entry.skills.join(', ') || '<none>'}), port the matching logic from the source repo into ${targetPath}/src/skills/. Rewrite — don't copy verbatim — to use @agentbuilder/llm and the Worker-safe runtime.`,
        },
        {
          step: 4,
          title: 'Port the tools',
          detail: `For each tool in the registry entry (${entry.tools.join(', ') || '<none>'}), port the matching handler into ${targetPath}/src/tools/. Shape them for runToolLoop.`,
        },
        {
          step: 5,
          title: 'Wire bindings',
          detail: `Update ${targetPath}/wrangler.toml to declare the registry's cloudflare bindings: DOs=${entry.cloudflare.durableObjects.join(',') || '-'} D1=${entry.cloudflare.d1.join(',') || '-'} KV=${entry.cloudflare.kv.join(',') || '-'} R2=${entry.cloudflare.r2.join(',') || '-'} hasAssets=${entry.cloudflare.hasAssets}. Set name = "${targetWorker}".`,
        },
        {
          step: 6,
          title: 'Port OAuth / secrets',
          detail: entry.oauthScopes.length > 0
            ? `Re-enter secrets for scopes: ${entry.oauthScopes.join(', ')}. Use "wrangler secret put" for each. Do NOT reuse tokens from the source worker unless they're user-scoped.`
            : 'No OAuth scopes declared. Prompt the user for any runtime secrets the source worker used (API keys, etc.) and add them via wrangler secret put.',
        },
        {
          step: 7,
          title: 'Parallel-run deploy',
          detail: `pnpm --filter @agentbuilder/app-${id} exec wrangler deploy. This deploys to "${targetWorker}.<subdomain>.workers.dev" alongside the existing "${sourceWorker}" worker — nothing is taken down yet.`,
        },
        {
          step: 8,
          title: 'Smoke test against parity scenarios',
          detail: 'Run the routing examples from the registry entry against the new worker. Compare against the old worker on the same inputs. Fix any regressions before proceeding.',
        },
        {
          step: 9,
          title: 'Cutover',
          detail: `Update any Claude.ai custom tool integrations pointing at "${sourceWorker}" to point at "${targetWorker}". Update registry lastDeployed. Keep "${sourceWorker}" running as the rollback target for at least 7 days.`,
        },
        {
          step: 10,
          title: 'Decommission source',
          detail: `After 7+ days of green parallel-run, delete the "${sourceWorker}" worker from Cloudflare and archive ${sourceRepo} on GitHub. Note the decommission date in docs/migrations/${id}.md.`,
        },
      ];

      return {
        id,
        targetPath,
        template,
        sourceRepo,
        sourceWorker,
        targetWorker,
        portNotes: portNotes || '(none provided)',
        steps,
      };
    },

    plan_scaffold: async (input) => {
      const id = String(input.id ?? '').trim();
      if (!id) return { error: 'id is required' };
      const entry = await store.getAgent(id);
      if (!entry) {
        return {
          error: `No agent with id "${id}" in the registry. The Architect should upsert the design first.`,
        };
      }
      const template = entry.kind === 'app' ? 'app-agent' : 'headless-agent';
      const targetPath = `apps/${id}`;

      const steps = [
        {
          step: 1,
          title: 'Copy template',
          detail: `cp -r .agent-builder/templates/${template}/ ${targetPath}/`,
        },
        {
          step: 2,
          title: 'Fill placeholders',
          detail: `Replace {{AGENT_ID}}=${id}, {{AGENT_NAME}}=${entry.name}, {{WORKER_NAME}}=${entry.cloudflare.workerName}, {{PURPOSE}}=${entry.purpose} across all files in ${targetPath}/.`,
        },
        {
          step: 3,
          title: 'Install + typecheck',
          detail: 'pnpm install && pnpm -F @agentbuilder/app-' + id + ' exec tsc --noEmit',
        },
        {
          step: 4,
          title: 'Wrangler dry-run',
          detail: `pnpm --filter @agentbuilder/app-${id} exec wrangler deploy --dry-run`,
        },
        {
          step: 5,
          title: 'Deploy',
          detail: `pnpm --filter @agentbuilder/app-${id} exec wrangler deploy`,
        },
        {
          step: 6,
          title: 'Register secrets',
          detail: entry.oauthScopes.length > 0
            ? `Prompt user for secrets covering scopes: ${entry.oauthScopes.join(', ')}`
            : 'Prompt user for ANTHROPIC_API_KEY and MCP_HTTP_KEY; add via wrangler secret put.',
        },
      ];

      return { id, targetPath, template, steps };
    },
  };

  return { tools, handlers };
}
