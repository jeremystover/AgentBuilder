/**
 * Model tiers. Call sites should import `ModelTier` and let this module
 * decide the concrete model. Change the mapping here to re-balance the
 * fleet's cost profile.
 */

export type ModelTier = 'fast' | 'default' | 'deep' | 'edge';

export interface ModelDescriptor {
  /** Provider id — today just 'anthropic' and 'workers-ai' */
  provider: 'anthropic' | 'workers-ai';
  /** Concrete model id passed to the provider */
  id: string;
  /** Hard ceiling on output tokens — tier-appropriate defaults */
  maxOutputTokens: number;
}

export const MODEL_TIERS: Record<ModelTier, ModelDescriptor> = {
  // Quick classification, routing, summarization, simple tool use
  fast: {
    provider: 'anthropic',
    id: 'claude-haiku-4-5',
    maxOutputTokens: 2048,
  },
  // The workhorse: ~80% of agent tasks should use this
  default: {
    provider: 'anthropic',
    id: 'claude-sonnet-4-6',
    maxOutputTokens: 4096,
  },
  // Architect / planner / hard debugging
  deep: {
    provider: 'anthropic',
    id: 'claude-opus-4-6',
    maxOutputTokens: 8192,
  },
  // Cheap bulk ops on Workers AI — embeddings, classification, local inference
  edge: {
    provider: 'workers-ai',
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    maxOutputTokens: 2048,
  },
};

export function resolveModel(tier: ModelTier): ModelDescriptor {
  return MODEL_TIERS[tier];
}
