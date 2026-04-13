/**
 * Registry store interface. Concrete stores live alongside:
 *   - MemoryRegistryStore (in ./memory-store.ts) — works in Workers
 *   - FileRegistryStore   (in ./node.ts)        — Node-only, uses node:fs
 */

import type { AgentEntry, Registry } from './schema.js';

export interface RegistryStore {
  load(): Promise<Registry>;
  save(registry: Registry): Promise<void>;
  getAgent(id: string): Promise<AgentEntry | undefined>;
  upsertAgent(entry: AgentEntry): Promise<void>;
  listAgents(): Promise<AgentEntry[]>;
}
