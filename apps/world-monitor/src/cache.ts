import type { CoarseCategory } from './registry/types.js';

export const CACHE_TTL_SECONDS: Readonly<Record<CoarseCategory, number>> = {
  markets: 60,
  news: 300,
  climate: 300,
  supply_chain: 600,
  cyber_infra: 300,
  government: 900,
  predictions: 300,
  geopolitics: 300,
};

const MIN_KV_TTL = 60;

export interface CachedValue {
  at: number;
  data: unknown;
}

export interface CacheEnv {
  WM_CACHE?: KVNamespace;
}

export function makeCacheKey(category: CoarseCategory, operation: string, params: Record<string, unknown>): string {
  const normalized = Object.keys(params)
    .sort()
    .map((k) => `${k}=${stableStringify(params[k])}`)
    .join('&');
  return `${category}:${operation}:${normalized}`;
}

export async function withCache<T>(
  env: CacheEnv,
  category: CoarseCategory,
  key: string,
  fetcher: () => Promise<T>,
): Promise<{ value: T; cached: boolean }> {
  if (!env.WM_CACHE) {
    return { value: await fetcher(), cached: false };
  }

  const raw = await env.WM_CACHE.get(key, { type: 'json' });
  if (raw && typeof raw === 'object') {
    const entry = raw as CachedValue;
    return { value: entry.data as T, cached: true };
  }

  const value = await fetcher();
  const ttl = Math.max(MIN_KV_TTL, CACHE_TTL_SECONDS[category]);
  const body: CachedValue = { at: Date.now(), data: value };
  try {
    await env.WM_CACHE.put(key, JSON.stringify(body), { expirationTtl: ttl });
  } catch {
    // best-effort: a failed cache write still returns the fresh value
  }
  return { value, cached: false };
}

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${k}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return String(v);
}
