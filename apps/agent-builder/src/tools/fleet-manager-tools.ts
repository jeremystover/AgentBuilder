/**
 * Fleet-Manager-specific tools — read-only audit verbs that let the Fleet
 * Manager persona reason about the shape of the whole fleet without
 * touching anything.
 *
 * Composes the shared registry read tools (list_agents, describe_agent,
 * check_overlap) with four audit tools:
 *
 *   - list_shared_package_consumers(pkg): which agents use a given shared
 *     package. Drives "if I refactor @agentbuilder/auth-github, who breaks?"
 *   - find_stale_agents(days): agents whose lastDeployed is older than N
 *     days (or never deployed). Surfaces rot.
 *   - diff_registry_entry(id, newEntry): structural diff between an
 *     existing registry entry and a proposed replacement. Does NOT write.
 *   - audit_non_goals(): scans every pair of agents and flags cases where
 *     one agent's purpose overlaps another's nonGoals — the drift detector.
 *
 * Everything is pure over the store. No writes, no network.
 */

import type { ToolDefinition, ToolHandler } from '@agentbuilder/llm';
import { AgentEntrySchema, type AgentEntry, type MemoryRegistryStore } from '@agentbuilder/registry';
import { buildRegistryTools } from './registry-tools.js';

export interface FleetManagerToolset {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}

export function buildFleetManagerTools(store: MemoryRegistryStore): FleetManagerToolset {
  const base = buildRegistryTools(store);

  const tools: ToolDefinition[] = [
    ...base.tools,
    {
      name: 'list_shared_package_consumers',
      description:
        'Return every agent that declares a given shared package in sharedPackages. Use this before recommending a refactor of a @agentbuilder/* package — it tells you the blast radius.',
      inputSchema: {
        type: 'object',
        properties: {
          pkg: {
            type: 'string',
            description: 'The package name, e.g. "@agentbuilder/auth-github".',
          },
        },
        required: ['pkg'],
        additionalProperties: false,
      },
    },
    {
      name: 'find_stale_agents',
      description:
        'Return agents whose lastDeployed timestamp is older than N days, plus agents with no lastDeployed at all. Use for rot audits. Agents with status "draft" are reported separately so you can ignore them if you want.',
      inputSchema: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'Staleness threshold in days. Default 30.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'diff_registry_entry',
      description:
        'Compute a field-level diff between the current registry entry for `id` and a proposed replacement `newEntry`. Returns added, removed, and changed fields. Does NOT write anything. Use to preview what a registry update would do.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The existing agent id.' },
          newEntry: {
            type: 'object',
            description: 'The proposed replacement entry. Must match AgentEntrySchema.',
          },
        },
        required: ['id', 'newEntry'],
        additionalProperties: false,
      },
    },
    {
      name: 'audit_non_goals',
      description:
        'Scan every pair of agents and flag cases where agent A\'s purpose or triggerPhrases appear to drift into agent B\'s nonGoals. This is the fleet drift detector — returns a list of {offender, owner, hint} tuples. Advisory only.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    ...base.handlers,

    list_shared_package_consumers: async (input) => {
      const pkg = String(input.pkg ?? '').trim();
      if (!pkg) return { error: 'pkg is required' };
      const agents = await store.listAgents();
      const consumers = agents
        .filter((a) => a.sharedPackages.includes(pkg))
        .map((a) => ({ id: a.id, name: a.name, status: a.status, version: a.version }));
      return { pkg, count: consumers.length, consumers };
    },

    find_stale_agents: async (input) => {
      const days = typeof input.days === 'number' && input.days > 0 ? input.days : 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const agents = await store.listAgents();
      const stale: Array<{ id: string; name: string; status: string; lastDeployed: string | null; ageDays: number | null }> = [];
      const neverDeployed: Array<{ id: string; name: string; status: string }> = [];
      for (const a of agents) {
        if (!a.lastDeployed) {
          neverDeployed.push({ id: a.id, name: a.name, status: a.status });
          continue;
        }
        const t = Date.parse(a.lastDeployed);
        if (Number.isNaN(t)) {
          neverDeployed.push({ id: a.id, name: a.name, status: a.status });
          continue;
        }
        if (t < cutoff) {
          stale.push({
            id: a.id,
            name: a.name,
            status: a.status,
            lastDeployed: a.lastDeployed,
            ageDays: Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)),
          });
        }
      }
      return { thresholdDays: days, stale, neverDeployed };
    },

    diff_registry_entry: async (input) => {
      const id = String(input.id ?? '').trim();
      if (!id) return { error: 'id is required' };
      const current = await store.getAgent(id);
      if (!current) {
        return { error: `No agent with id "${id}". Call list_agents to see valid ids.` };
      }
      const parsed = AgentEntrySchema.safeParse(input.newEntry);
      if (!parsed.success) {
        return {
          error: 'newEntry failed schema validation',
          issues: parsed.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        };
      }
      return { id, diff: diffEntries(current, parsed.data) };
    },

    audit_non_goals: async () => {
      const agents = await store.listAgents();
      const findings: Array<{ offender: string; owner: string; hint: string }> = [];
      for (const owner of agents) {
        const nonGoalTokens = owner.routing.nonGoals.map((ng) => ({
          text: ng,
          tokens: tokenize(ng),
        }));
        for (const offender of agents) {
          if (offender.id === owner.id) continue;
          const offenderText = `${offender.purpose} ${offender.routing.triggerPhrases.join(' ')}`;
          const offenderTokens = tokenize(offenderText);
          for (const ng of nonGoalTokens) {
            if (ng.tokens.size === 0) continue;
            const overlap = jaccard(ng.tokens, offenderTokens);
            if (overlap >= 0.25) {
              findings.push({
                offender: offender.id,
                owner: owner.id,
                hint: `"${offender.name}" may be drifting into "${owner.name}"'s non-goal: ${ng.text}`,
              });
            }
          }
        }
      }
      return { count: findings.length, findings };
    },
  };

  return { tools, handlers };
}

/**
 * Shallow structural diff for registry entries. Returns changed fields as
 * {before, after} pairs. Arrays are compared by set membership (added /
 * removed) because order isn't meaningful for skills/tools/scopes.
 */
function diffEntries(before: AgentEntry, after: AgentEntry) {
  const changes: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof AgentEntry>;
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    if (Array.isArray(b) && Array.isArray(a)) {
      const ba = b as unknown[];
      const aa = a as unknown[];
      const added = aa.filter((x) => !ba.includes(x));
      const removed = ba.filter((x) => !aa.includes(x));
      if (added.length > 0 || removed.length > 0) {
        changes[key] = { added, removed };
      }
      continue;
    }
    if (typeof b === 'object' && b !== null && typeof a === 'object' && a !== null) {
      if (JSON.stringify(b) !== JSON.stringify(a)) {
        changes[key] = { before: b, after: a };
      }
      continue;
    }
    if (b !== a) {
      changes[key] = { before: b, after: a };
    }
  }
  return changes;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at',
  'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'that', 'this', 'it', 'its', 'agent', 'agents', 'not', 'does',
  'do', 'no',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
