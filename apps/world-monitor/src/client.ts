import type { ParamDef, ToolDef } from './registry/types.js';

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [1_000, 2_000];

export interface CallOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  headers?: Record<string, string>;
}

export interface RawResponse {
  status: number;
  data: unknown;
  truncated?: TruncationInfo;
}

export interface TruncationInfo {
  original_size: number;
  original_items?: number;
  note: string;
}

export class UpstreamError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export async function callUrl(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  opts: CallOptions = {},
): Promise<RawResponse> {
  const timeout = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxResponseBytes ?? 100_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (RETRY_STATUSES.has(res.status) && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt] ?? 1_000);
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new UpstreamError(res.status, `Upstream ${res.status} from ${url}`, text.slice(0, 500));
      }

      const data = parseBody(text, url);
      const { value, truncated } = truncate(data, maxBytes);
      return { status: res.status, data: value, truncated };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof UpstreamError) throw err;
      lastErr = err;
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt] ?? 1_000);
        continue;
      }
      throw new UpstreamError(0, `Network error calling ${url}: ${errMsg(err)}`);
    }
  }
  throw new UpstreamError(0, `Exhausted retries calling ${url}: ${errMsg(lastErr)}`);
}

function parseBody(text: string, url: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    throw new UpstreamError(502, `Upstream returned HTML instead of JSON from ${url}`, trimmed.slice(0, 200));
  }
  if (!trimmed) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function buildQueryString(
  params: Record<string, unknown>,
  schema: Record<string, ParamDef> | undefined,
): string {
  if (!schema) return '';
  const search = new URLSearchParams();
  for (const [key, def] of Object.entries(schema)) {
    const val = params[key];
    if (val === undefined || val === null || val === '') continue;
    if (def.type === 'string[]' && Array.isArray(val)) {
      search.set(key, val.join(','));
    } else {
      search.set(key, String(val));
    }
  }
  const q = search.toString();
  return q ? `?${q}` : '';
}

export function validateRequired(
  tool: ToolDef,
  params: Record<string, unknown>,
): void {
  if (!tool.params) return;
  for (const [key, def] of Object.entries(tool.params)) {
    if (def.required && (params[key] === undefined || params[key] === null || params[key] === '')) {
      throw new UpstreamError(400, `Missing required parameter "${key}" for ${tool.name}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(
  value: unknown,
  maxBytes: number,
): { value: unknown; truncated?: TruncationInfo } {
  const original = JSON.stringify(value ?? null);
  if (original.length <= maxBytes) return { value };

  if (typeof value !== 'object' || value === null) {
    return {
      value: `${original.slice(0, maxBytes)}... [TRUNCATED]`,
      truncated: {
        original_size: original.length,
        note: `Response exceeded ${maxBytes} bytes; hard-truncated.`,
      },
    };
  }

  const cloned: unknown = JSON.parse(original);
  const largest = findLargestArray(cloned);
  if (!largest) {
    return {
      value: `${original.slice(0, maxBytes)}... [TRUNCATED]`,
      truncated: {
        original_size: original.length,
        note: `Response exceeded ${maxBytes} bytes; hard-truncated (no array to shrink).`,
      },
    };
  }

  const originalItems = largest.arr.length;
  while (JSON.stringify(cloned).length > maxBytes && largest.arr.length > 1) {
    largest.arr.length = Math.max(1, Math.floor(largest.arr.length / 2));
  }

  return {
    value: cloned,
    truncated: {
      original_size: original.length,
      original_items: originalItems,
      note: `Largest array trimmed from ${originalItems} to ${largest.arr.length} items to fit ${maxBytes} bytes.`,
    },
  };
}

function findLargestArray(root: unknown): { arr: unknown[] } | null {
  let best: { arr: unknown[] } | null = null;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (!best || node.length > best.arr.length) best = { arr: node };
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) visit(v);
    }
  };
  visit(root);
  return best;
}
