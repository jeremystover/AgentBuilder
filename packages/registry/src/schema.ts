import { z } from 'zod';

/**
 * The registry schema. Every field here is something AgentBuilder's
 * personas need to reason about the fleet. Add fields sparingly —
 * registry bloat makes the overlap-detection and routing prompts longer
 * and more expensive.
 */

export const AgentRoutingSchema = z.object({
  /** Short phrases that should route to this agent */
  triggerPhrases: z.array(z.string()).default([]),
  /** Example user requests this agent handles well */
  examples: z.array(z.string()).default([]),
  /**
   * Things this agent explicitly does NOT do. This is the key field for
   * overlap detection — keeps agents from drifting into each other's turf.
   */
  nonGoals: z.array(z.string()).default([]),
});

export const CloudflareBindingsSchema = z.object({
  workerName: z.string(),
  durableObjects: z.array(z.string()).default([]),
  d1: z.array(z.string()).default([]),
  kv: z.array(z.string()).default([]),
  r2: z.array(z.string()).default([]),
  queues: z.array(z.string()).default([]),
  /** True if the worker serves a UI (static assets binding) */
  hasAssets: z.boolean().default(false),
});

export const AgentEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'kebab-case only'),
  name: z.string(),
  /** One-sentence description of what this agent does */
  purpose: z.string().min(10),
  owner: z.string(),
  status: z.enum(['active', 'draft', 'deprecated']),
  kind: z.enum(['headless', 'app']),

  skills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).default([]),
  sharedPackages: z.array(z.string()).default([]),
  oauthScopes: z.array(z.string()).default([]),

  cloudflare: CloudflareBindingsSchema,
  routing: AgentRoutingSchema,

  version: z.string().default('0.0.1'),
  lastEval: z.string().optional(),
  lastDeployed: z.string().optional(),
});

export const RegistrySchema = z.object({
  $schemaVersion: z.literal(1),
  updatedAt: z.string(),
  agents: z.array(AgentEntrySchema),
});

export type AgentEntry = z.infer<typeof AgentEntrySchema>;
export type Registry = z.infer<typeof RegistrySchema>;
export type CloudflareBindings = z.infer<typeof CloudflareBindingsSchema>;
export type AgentRouting = z.infer<typeof AgentRoutingSchema>;
