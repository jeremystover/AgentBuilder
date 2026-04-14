/**
 * Architect-specific tools — everything the Architect persona needs on top
 * of the shared registry read tools in registry-tools.ts.
 *
 * Two kinds of tools:
 *   - validate_design: parses a proposed design spec (JSON) and validates
 *     it against the AgentEntrySchema, returning either {valid: true} or
 *     a concrete list of errors. Lets the Architect self-check before
 *     handing off to the Builder.
 *   - suggest_worker_name: trivial naming-convention helper so every
 *     scaffolded agent gets a predictable Cloudflare worker name.
 *
 * Neither tool touches the store — they're pure functions. They live
 * separately from registry-tools.ts so the Fleet Manager doesn't inherit
 * Architect-specific verbs.
 */

import type { ToolDefinition, ToolHandler } from '@agentbuilder/llm';
import { AgentEntrySchema, type MemoryRegistryStore } from '@agentbuilder/registry';
import { buildRegistryTools } from './registry-tools.js';

export interface ArchitectToolset {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
}

/**
 * Returns the full Architect toolset: the shared registry read tools
 * (list_agents, describe_agent, check_overlap) plus validate_design and
 * suggest_worker_name.
 */
export function buildArchitectTools(store: MemoryRegistryStore): ArchitectToolset {
  const base = buildRegistryTools(store);

  const tools: ToolDefinition[] = [
    ...base.tools,
    {
      name: 'validate_design',
      description:
        'Validate a proposed agent design spec against the registry schema BEFORE emitting HANDOFF: builder. ' +
        'Pass the design as a JSON object matching AgentEntrySchema. ' +
        'Returns {valid: true} or {valid: false, errors: [...]}. ' +
        'Call this as your last step before handoff — it catches shape mistakes that would otherwise break the Builder.',
      inputSchema: {
        type: 'object',
        properties: {
          design: {
            type: 'object',
            description:
              'The proposed design spec. Must have id, name, purpose, owner, status, kind, and a routing object with nonGoals. See AgentEntrySchema for the full shape.',
          },
        },
        required: ['design'],
        additionalProperties: false,
      },
    },
    {
      name: 'suggest_worker_name',
      description:
        'Return the recommended Cloudflare worker name for an agent id. Always returns the id itself — the fleet convention is that worker name === agent id === kebab-case. Use this to fill in the cloudflare.workerName field of the design.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The kebab-case agent id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    ...base.handlers,

    validate_design: async (input) => {
      const design = input.design as unknown;
      if (!design || typeof design !== 'object') {
        return { valid: false, errors: ['design must be an object'] };
      }
      const result = AgentEntrySchema.safeParse(design);
      if (result.success) {
        return { valid: true, normalized: result.data };
      }
      return {
        valid: false,
        errors: result.error.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      };
    },

    suggest_worker_name: async (input) => {
      const id = String(input.id ?? '').trim();
      if (!/^[a-z][a-z0-9-]*$/.test(id)) {
        return {
          error: `id "${id}" is not kebab-case. Use lowercase letters, digits, and hyphens; start with a letter.`,
        };
      }
      return { workerName: id };
    },
  };

  return { tools, handlers };
}
