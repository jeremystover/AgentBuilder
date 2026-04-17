import { buildQueryString, callUrl, UpstreamError, validateRequired } from './client.js';
import { makeCacheKey, withCache } from './cache.js';
import { directHandlers } from './handlers/index.js';
import { OPERATIONS_BY_CATEGORY, REGISTRY } from './registry/index.js';
import type { CoarseCategory, ServiceDef, ToolDef } from './registry/types.js';

export interface DispatchEnv {
  WM_CACHE?: KVNamespace;
  WORLDMONITOR_BASE_URL?: string;
  WORLDMONITOR_API_KEY?: string;
  WORLDMONITOR_TIMEOUT?: string;
  WORLDMONITOR_MAX_RESPONSE_SIZE?: string;
}

export interface DispatchResult {
  data: unknown;
  meta: {
    category: CoarseCategory;
    operation: string;
    source: 'proxy' | 'direct';
    cached: boolean;
    truncated?: { original_size: number; original_items?: number; note: string };
  };
}

export async function dispatch(
  env: DispatchEnv,
  category: CoarseCategory,
  operation: string,
  params: Record<string, unknown>,
): Promise<DispatchResult> {
  const entry = REGISTRY.get(operation);
  if (!entry) {
    const available = OPERATIONS_BY_CATEGORY[category].map((t) => t.name);
    if (available.length === 0) {
      throw new UpstreamError(
        501,
        `Category "${category}" has no wired operations yet. Supported in v1: markets, news, climate, government.`,
      );
    }
    throw new UpstreamError(
      404,
      `Unknown operation "${operation}" for category "${category}". Available: ${available.join(', ')}.`,
    );
  }
  if (entry.category !== category) {
    throw new UpstreamError(
      400,
      `Operation "${operation}" belongs to category "${entry.category}", not "${category}".`,
    );
  }

  validateRequired(entry.tool, params);

  const cacheKey = makeCacheKey(category, operation, params);
  let truncated: DispatchResult['meta']['truncated'];

  const { value, cached } = await withCache(env, category, cacheKey, async () => {
    if (entry.direct) {
      const handler = directHandlers[operation];
      if (!handler) {
        throw new UpstreamError(
          501,
          `Operation "${operation}" is marked direct but has no handler registered.`,
        );
      }
      return await handler(params);
    }
    const result = await proxyCall(env, entry.service, entry.tool, params);
    truncated = result.truncated;
    return result.data;
  });

  return {
    data: value,
    meta: {
      category,
      operation,
      source: entry.direct ? 'direct' : 'proxy',
      cached,
      truncated,
    },
  };
}

async function proxyCall(
  env: DispatchEnv,
  service: ServiceDef,
  tool: ToolDef,
  params: Record<string, unknown>,
) {
  const baseUrl = (env.WORLDMONITOR_BASE_URL ?? 'https://worldmonitor.app').replace(/\/+$/, '');
  const method = tool.method ?? 'GET';
  const qs = method === 'GET' ? buildQueryString(params, tool.params) : '';
  const url = `${baseUrl}${service.basePath}${tool.endpoint}${qs}`;

  const headers: Record<string, string> = {};
  if (env.WORLDMONITOR_API_KEY) headers.authorization = `Bearer ${env.WORLDMONITOR_API_KEY}`;

  const timeoutMs = env.WORLDMONITOR_TIMEOUT ? Number(env.WORLDMONITOR_TIMEOUT) : undefined;
  const maxResponseBytes = env.WORLDMONITOR_MAX_RESPONSE_SIZE
    ? Number(env.WORLDMONITOR_MAX_RESPONSE_SIZE)
    : undefined;

  return callUrl(url, method, method === 'POST' ? params : undefined, {
    timeoutMs,
    maxResponseBytes,
    headers,
  });
}
