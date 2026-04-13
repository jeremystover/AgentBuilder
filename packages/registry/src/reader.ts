/**
 * Registry reader/writer. File-based for now (registry/agents.json at the
 * repo root). Swap the file operations out for a D1-backed store later
 * without changing the public surface.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RegistrySchema, type AgentEntry, type Registry } from './schema.js';

export interface RegistryStore {
  load(): Promise<Registry>;
  save(registry: Registry): Promise<void>;
  getAgent(id: string): Promise<AgentEntry | undefined>;
  upsertAgent(entry: AgentEntry): Promise<void>;
  listAgents(): Promise<AgentEntry[]>;
}

export class FileRegistryStore implements RegistryStore {
  constructor(private readonly path: string) {}

  static fromRepoRoot(repoRoot: string): FileRegistryStore {
    return new FileRegistryStore(resolve(repoRoot, 'registry/agents.json'));
  }

  async load(): Promise<Registry> {
    const raw = await readFile(this.path, 'utf8');
    return RegistrySchema.parse(JSON.parse(raw));
  }

  async save(registry: Registry): Promise<void> {
    const validated = RegistrySchema.parse({
      ...registry,
      updatedAt: new Date().toISOString(),
    });
    await writeFile(this.path, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  }

  async listAgents(): Promise<AgentEntry[]> {
    const reg = await this.load();
    return reg.agents;
  }

  async getAgent(id: string): Promise<AgentEntry | undefined> {
    const agents = await this.listAgents();
    return agents.find((a) => a.id === id);
  }

  async upsertAgent(entry: AgentEntry): Promise<void> {
    const reg = await this.load();
    const idx = reg.agents.findIndex((a) => a.id === entry.id);
    if (idx >= 0) reg.agents[idx] = entry;
    else reg.agents.push(entry);
    await this.save(reg);
  }
}
