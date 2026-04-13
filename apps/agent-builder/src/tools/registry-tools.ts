/**
 * Registry tools exposed to the Architect persona.
 *
 * These are deliberately read-only — the Architect's job is to design,
 * not to mutate the fleet. The Builder gets its own write-capable tools.
 *
 * Every tool is shaped for LLM consumption:
 *   - definition: the schema the model sees
 *   - handler: a pure async function over the registry store
 *
 * Keep the descriptions tight and example-driven. The model re-reads them
 * every turn, so bloat is expensive.
 */

import type { ToolDefinition, ToolHandler } from '@agentbuilder/llm';
import type { MemoryRegistryStore } from '@agentbuilder/registry';

export interface RegistryToolset {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}

export function buildRegistryTools(store: MemoryRegistryStore): RegistryToolset {
  const tools: ToolDefinition[] = [
    {
      name: 'list_agents',
      description:
        'List every agent in the fleet with id, name, status, purpose, and non-goals. Use this first when the user mentions wanting a new agent — always check if an existing one already covers the use case before proposing a new one.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'describe_agent',
      description:
        'Get the full registry entry for a specific agent by id: tools, shared packages, Cloudflare bindings, routing examples. Use when deciding whether to extend an existing agent rather than creating a new one.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The kebab-case agent id, e.g. "agent-builder".' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'check_overlap',
      description:
        'Given a proposed agent purpose and non-goals, return any existing agents whose purpose overlaps. Uses simple keyword similarity — the result is advisory, you still need to judge severity.',
      inputSchema: {
        type: 'object',
        properties: {
          purpose: {
            type: 'string',
            description: 'One-sentence purpose for the proposed new agent.',
          },
          nonGoals: {
            type: 'array',
            items: { type: 'string' },
            description: 'Things the proposed agent should NOT do.',
          },
        },
        required: ['purpose'],
        additionalProperties: false,
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    list_agents: async () => {
      const agents = await store.listAgents();
      return agents.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        kind: a.kind,
        purpose: a.purpose,
        nonGoals: a.routing.nonGoals,
      }));
    },

    describe_agent: async (input) => {
      const id = String(input.id);
      const agent = await store.getAgent(id);
      if (!agent) {
        return { error: `No agent with id "${id}". Call list_agents to see valid ids.` };
      }
      return agent;
    },

    check_overlap: async (input) => {
      const purpose = String(input.purpose ?? '').toLowerCase();
      const nonGoals = Array.isArray(input.nonGoals) ? (input.nonGoals as string[]) : [];

      const proposedTokens = tokenize(purpose);
      if (proposedTokens.size === 0) {
        return { candidates: [] };
      }

      const agents = await store.listAgents();
      const candidates = agents
        .map((a) => {
          const agentTokens = tokenize(`${a.purpose} ${a.routing.triggerPhrases.join(' ')}`);
          const overlap = jaccard(proposedTokens, agentTokens);
          const nonGoalConflict = nonGoals.some((ng) =>
            a.purpose.toLowerCase().includes(ng.toLowerCase().slice(0, 20)),
          );
          return {
            id: a.id,
            name: a.name,
            purpose: a.purpose,
            similarity: overlap,
            nonGoalConflict,
          };
        })
        .filter((c) => c.similarity >= 0.15 || c.nonGoalConflict)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 5);

      return { candidates };
    },
  };

  return { tools, handlers };
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'for',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'that',
  'this',
  'it',
  'its',
  'agent',
  'agents',
  'new',
  'one',
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
