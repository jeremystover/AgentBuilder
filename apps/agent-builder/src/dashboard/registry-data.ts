/**
 * Registry data, bundled at build time.
 *
 * Wrangler/esbuild inlines the JSON at the repo root into the Worker bundle.
 * Whenever `registry/agents.json` changes the worker rebuilds, so the
 * dashboard stays in sync without a runtime fetch.
 */

// eslint-disable-next-line import/no-relative-parent-imports
import registry from '../../../../registry/agents.json';

export interface CronEntry {
  schedule: string;
  trigger: string;
  description: string;
}

export interface AgentEntry {
  id: string;
  name: string;
  purpose: string;
  owner: string;
  status: 'active' | 'draft' | 'deprecated';
  kind: 'headless' | 'app';
  skills: string[];
  tools: string[];
  toolDescriptions?: Record<string, string>;
  mcpServers: string[];
  sharedPackages: string[];
  oauthScopes: string[];
  cloudflare: {
    workerName: string;
    durableObjects: string[];
    d1: string[];
    kv: string[];
    r2: string[];
    queues: string[];
    hasAssets: boolean;
  };
  routing: {
    triggerPhrases: string[];
    examples: string[];
    nonGoals: string[];
  };
  crons?: CronEntry[];
  secrets?: string[];
  version: string;
  lastDeployed?: string;
}

export interface RegistryData {
  $schemaVersion: number;
  updatedAt: string;
  agents: AgentEntry[];
}

export const REGISTRY = registry as unknown as RegistryData;
