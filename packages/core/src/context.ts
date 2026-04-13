/**
 * AgentContext carries the per-invocation state that every agent handler
 * expects. Construct it at the Worker entrypoint and thread it through.
 *
 * This is intentionally narrow — agents needing more should wrap it, not
 * bloat this type.
 */

import type { Logger } from './logger.js';

export interface AgentIdentity {
  /** Stable id matching registry/agents.json */
  agentId: string;
  /** Human-readable display name */
  name: string;
  /** Semantic version from the agent's package.json */
  version: string;
}

export interface AgentPrincipal {
  /** Opaque end-user id (Google sub, Auth0 id, etc.) */
  userId: string;
  /** Optional tenant/org id for multi-tenant agents */
  tenantId?: string;
}

export interface AgentContext {
  agent: AgentIdentity;
  requestId: string;
  logger: Logger;
  principal?: AgentPrincipal;
  /** Milliseconds since epoch — injected for determinism in tests */
  now: () => number;
}
