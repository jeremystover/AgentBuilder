/**
 * MemoryRegistryStore — an in-memory RegistryStore implementation suitable
 * for Cloudflare Workers. Construct with the registry JSON imported at
 * build time:
 *
 *   import registryData from '../../../registry/agents.json';
 *   const store = new MemoryRegistryStore(registryData);
 *
 * Writes are held in memory only. Persistence (to D1, R2, or back to
 * GitHub via a PR) is a separate concern for phase 2+.
 */

import type { RegistryStore } from './reader.js';
import { type AgentEntry, type Registry, RegistrySchema } from './schema.js';

export class MemoryRegistryStore implements RegistryStore {
  private registry: Registry;

  constructor(initial: unknown) {
    this.registry = RegistrySchema.parse(initial);
  }

  async load(): Promise<Registry> {
    return this.registry;
  }

  async save(registry: Registry): Promise<void> {
    this.registry = RegistrySchema.parse({
      ...registry,
      updatedAt: new Date().toISOString(),
    });
  }

  async listAgents(): Promise<AgentEntry[]> {
    return this.registry.agents;
  }

  async getAgent(id: string): Promise<AgentEntry | undefined> {
    return this.registry.agents.find((a) => a.id === id);
  }

  async upsertAgent(entry: AgentEntry): Promise<void> {
    const idx = this.registry.agents.findIndex((a) => a.id === entry.id);
    if (idx >= 0) this.registry.agents[idx] = entry;
    else this.registry.agents.push(entry);
    await this.save(this.registry);
  }
}
