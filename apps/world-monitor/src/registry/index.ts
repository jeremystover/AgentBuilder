import { market } from './services/market.js';
import { news } from './services/news.js';
import { secEdgar } from './services/sec-edgar.js';
import { seismology } from './services/seismology.js';
import type { CoarseCategory, RegistryEntry, ServiceDef, ToolDef } from './types.js';

interface ServiceMapping {
  service: ServiceDef;
  category: CoarseCategory;
  /** true = handler in src/handlers/* calls upstream directly; false = proxy to worldmonitor.app */
  direct: boolean;
}

const SERVICES: ServiceMapping[] = [
  { service: market, category: 'markets', direct: false },
  { service: news, category: 'news', direct: false },
  { service: seismology, category: 'climate', direct: false },
  { service: secEdgar, category: 'government', direct: true },
];

/** Map of operation name → entry. Operation names are globally unique across services. */
export const REGISTRY: ReadonlyMap<string, RegistryEntry & { direct: boolean }> = (() => {
  const map = new Map<string, RegistryEntry & { direct: boolean }>();
  for (const { service, category, direct } of SERVICES) {
    for (const tool of service.tools) {
      if (map.has(tool.name)) {
        throw new Error(`Duplicate operation name in registry: ${tool.name}`);
      }
      map.set(tool.name, { service, tool, category, direct });
    }
  }
  return map;
})();

/** Operations grouped by coarse category — used to render per-tool `operation` enums. */
export const OPERATIONS_BY_CATEGORY: Readonly<Record<CoarseCategory, ToolDef[]>> = (() => {
  const out: Record<CoarseCategory, ToolDef[]> = {
    markets: [],
    geopolitics: [],
    news: [],
    climate: [],
    supply_chain: [],
    cyber_infra: [],
    government: [],
    predictions: [],
  };
  for (const { service, category } of SERVICES) {
    out[category].push(...service.tools);
  }
  return out;
})();
