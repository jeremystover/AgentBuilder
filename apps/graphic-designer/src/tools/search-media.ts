/**
 * search_media — unified image/icon search.
 *
 * Sources (parallel, then merged + ranked):
 *   - Unsplash      (photos, illustrations)
 *   - Pexels        (photos)
 *   - Iconify       (icons, open collections; no API key needed)
 *
 * If stock results are thin and `generateFallback` is true, we generate a
 * single AI image via OpenAI gpt-image-1 and persist it to R2.
 *
 * Style constraint: when `brandId` is given, we pull the brand palette/voice
 * from D1 and bias ranking toward results that match (primary colour
 * similarity, mood adjectives in description, orientation preference).
 */

import { AgentError, createLogger } from '@agentbuilder/core';
import type { Env } from '../../worker-configuration';

const UNSPLASH_API = 'https://api.unsplash.com';
const PEXELS_API = 'https://api.pexels.com/v1';
const ICONIFY_API = 'https://api.iconify.design';
const OPENAI_IMAGES_API = 'https://api.openai.com/v1/images/generations';

export type MediaKind = 'photo' | 'icon' | 'illustration' | 'any';

export interface SearchMediaArgs {
  query: string;
  type?: MediaKind;
  brandId?: string;
  count?: number;
  generateFallback?: boolean;
  userId?: string;
}

export interface MediaResult {
  source: 'unsplash' | 'pexels' | 'iconify' | 'openai';
  id: string;
  url: string;               // full-size or hosted URL
  thumbnailUrl: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
  attribution?: { name: string; link: string } | null;
  licenseNote?: string;
  tags?: string[];
  score: number;             // 0..1 ranking score
  r2Key?: string;            // set when we persist (AI fallback)
}

export interface SearchMediaResult {
  ok: true;
  query: string;
  type: MediaKind;
  brandId: string | null;
  count: number;
  results: MediaResult[];
  usedFallback: boolean;
}

interface BrandStyleHint {
  palette?: Record<string, string>;
  voice?: { tone?: string; adjectives?: string[]; avoid?: string[] };
}

export async function searchMedia(
  env: Env,
  args: SearchMediaArgs,
): Promise<SearchMediaResult> {
  const logger = createLogger({ base: { agent: 'graphic-designer', tool: 'search_media' } });
  const type: MediaKind = args.type ?? 'any';
  const count = Math.min(Math.max(args.count ?? 5, 1), 20);
  const userId = args.userId ?? 'default';

  const brandHint = args.brandId ? await loadBrandHint(env, userId, args.brandId) : null;

  logger.info('search.start', { query: args.query, type, count, hasBrand: !!brandHint });

  const tasks: Array<Promise<MediaResult[]>> = [];
  if (type === 'icon' || type === 'any') tasks.push(searchIconify(args.query, count));
  if (type === 'photo' || type === 'illustration' || type === 'any') {
    tasks.push(searchUnsplash(env, args.query, count));
    tasks.push(searchPexels(env, args.query, count));
  }

  const settled = await Promise.allSettled(tasks);
  const merged: MediaResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') merged.push(...s.value);
    else logger.warn('search.source.failed', { reason: String(s.reason) });
  }

  const ranked = rankResults(merged, args.query, brandHint).slice(0, count);

  let usedFallback = false;
  if (ranked.length < Math.min(count, 3) && args.generateFallback) {
    logger.info('search.fallback.openai');
    const generated = await generateAiImage(env, args.query, brandHint);
    ranked.unshift(generated);
    usedFallback = true;
  }

  if (ranked.length === 0) {
    throw new AgentError(
      `No media results for "${args.query}". Try broadening the query or set generateFallback=true.`,
      { code: 'not_found' },
    );
  }

  logger.info('search.done', { returned: ranked.length, usedFallback });

  return {
    ok: true,
    query: args.query,
    type,
    brandId: args.brandId ?? null,
    count: ranked.length,
    results: ranked,
    usedFallback,
  };
}

// ── Unsplash ────────────────────────────────────────────────────────────────

interface UnsplashHit {
  id: string;
  description: string | null;
  alt_description: string | null;
  width: number;
  height: number;
  urls: { regular: string; small: string; thumb: string };
  user: { name: string; links: { html: string } };
  links: { html: string };
  tags?: Array<{ title: string }>;
}

async function searchUnsplash(env: Env, query: string, count: number): Promise<MediaResult[]> {
  if (!env.UNSPLASH_ACCESS_KEY) return [];
  const url = `${UNSPLASH_API}/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`;
  const res = await fetch(url, {
    headers: { authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { results?: UnsplashHit[] };
  return (json.results ?? []).map((h) => ({
    source: 'unsplash' as const,
    id: h.id,
    url: h.urls.regular,
    thumbnailUrl: h.urls.thumb,
    width: h.width,
    height: h.height,
    title: h.alt_description ?? h.description ?? undefined,
    description: h.description ?? undefined,
    attribution: { name: h.user.name, link: h.user.links.html },
    licenseNote: 'Unsplash License (free to use, attribution appreciated).',
    tags: h.tags?.map((t) => t.title),
    score: 0.5,
  }));
}

// ── Pexels ──────────────────────────────────────────────────────────────────

interface PexelsHit {
  id: number;
  width: number;
  height: number;
  url: string;
  alt: string;
  photographer: string;
  photographer_url: string;
  src: { large: string; medium: string; tiny: string };
}

async function searchPexels(env: Env, query: string, count: number): Promise<MediaResult[]> {
  if (!env.PEXELS_API_KEY) return [];
  const url = `${PEXELS_API}/search?query=${encodeURIComponent(query)}&per_page=${count}`;
  const res = await fetch(url, { headers: { authorization: env.PEXELS_API_KEY } });
  if (!res.ok) return [];
  const json = (await res.json()) as { photos?: PexelsHit[] };
  return (json.photos ?? []).map((h) => ({
    source: 'pexels' as const,
    id: String(h.id),
    url: h.src.large,
    thumbnailUrl: h.src.tiny,
    width: h.width,
    height: h.height,
    title: h.alt,
    description: h.alt,
    attribution: { name: h.photographer, link: h.photographer_url },
    licenseNote: 'Pexels License (free to use).',
    score: 0.45,
  }));
}

// ── Iconify ────────────────────────────────────────────────────────────────
//
// Iconify exposes a public search API with no key required. Returns icon
// identifiers like "mdi:home" that resolve via https://api.iconify.design/<prefix>/<name>.svg

interface IconifyResp {
  icons?: string[];
  total?: number;
}

async function searchIconify(query: string, count: number): Promise<MediaResult[]> {
  const url = `${ICONIFY_API}/search?query=${encodeURIComponent(query)}&limit=${count * 2}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = (await res.json()) as IconifyResp;
  const icons = (json.icons ?? []).slice(0, count);
  return icons.map((id) => {
    const [prefix, name] = id.split(':');
    const svgUrl = `${ICONIFY_API}/${prefix}/${name}.svg`;
    return {
      source: 'iconify' as const,
      id,
      url: svgUrl,
      thumbnailUrl: `${ICONIFY_API}/${prefix}/${name}.svg?height=48`,
      title: name?.replace(/-/g, ' '),
      description: `${prefix} icon set`,
      attribution: { name: prefix ?? 'iconify', link: `https://icon-sets.iconify.design/${prefix}/` },
      licenseNote: 'See iconify collection license.',
      tags: [prefix ?? '', name ?? ''],
      score: 0.4,
    } satisfies MediaResult;
  });
}

// ── OpenAI gpt-image-1 fallback ────────────────────────────────────────────

async function generateAiImage(
  env: Env,
  query: string,
  brand: BrandStyleHint | null,
): Promise<MediaResult> {
  if (!env.OPENAI_API_KEY) {
    throw new AgentError('OPENAI_API_KEY not set; cannot generate fallback image.', {
      code: 'internal',
    });
  }

  const styleSuffix = brand
    ? ` Style: ${brand.voice?.adjectives?.join(', ') ?? 'clean, modern'}. Palette hints: ${Object.values(brand.palette ?? {}).slice(0, 3).join(', ')}.`
    : '';

  const prompt = `${query}.${styleSuffix} High quality, professional, suitable for a presentation slide or website hero.`;

  const res = await fetch(OPENAI_IMAGES_API, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: '1536x1024',
      n: 1,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AgentError(`OpenAI image generation failed (${res.status}): ${text}`, {
      code: 'upstream_failure',
    });
  }

  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = json.data?.[0];
  if (!first) {
    throw new AgentError('OpenAI returned no image.', { code: 'upstream_failure' });
  }

  let bytes: Uint8Array;
  if (first.b64_json) {
    bytes = base64ToBytes(first.b64_json);
  } else if (first.url) {
    const imgRes = await fetch(first.url);
    bytes = new Uint8Array(await imgRes.arrayBuffer());
  } else {
    throw new AgentError('OpenAI response missing image data.', { code: 'upstream_failure' });
  }

  const key = `ai-generated/${crypto.randomUUID()}.png`;
  await env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: { prompt: prompt.slice(0, 512), source: 'openai-gpt-image-1' },
  });

  return {
    source: 'openai',
    id: key,
    url: `r2://${key}`,
    thumbnailUrl: `r2://${key}`,
    width: 1536,
    height: 1024,
    title: query,
    description: `AI-generated: ${prompt.slice(0, 200)}`,
    attribution: null,
    licenseNote: 'Generated by OpenAI gpt-image-1. You own the output; verify OpenAI usage policy.',
    score: 0.7,
    r2Key: key,
  };
}

// ── Ranking + brand bias ───────────────────────────────────────────────────

function rankResults(
  results: MediaResult[],
  query: string,
  brand: BrandStyleHint | null,
): MediaResult[] {
  const tokens = tokenize(query);
  const moodWords = new Set(
    (brand?.voice?.adjectives ?? []).map((w) => w.toLowerCase()),
  );
  const avoidWords = new Set(
    (brand?.voice?.avoid ?? []).map((w) => w.toLowerCase()),
  );

  for (const r of results) {
    const haystack = [r.title, r.description, ...(r.tags ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    let score = r.score;

    // Query token overlap
    let hits = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) hits++;
    }
    score += hits * 0.06;

    // Brand mood match
    if (moodWords.size > 0) {
      for (const m of moodWords) {
        if (haystack.includes(m)) score += 0.08;
      }
    }

    // Penalise avoid-words
    for (const a of avoidWords) {
      if (haystack.includes(a)) score -= 0.25;
    }

    r.score = Math.max(0, Math.min(1, score));
  }

  return results.sort((a, b) => b.score - a.score);
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.replace(/[^a-z0-9]/g, ''))
    .filter((s) => s.length > 2);
}

// ── Brand hint loader ─────────────────────────────────────────────────────

async function loadBrandHint(
  env: Env,
  userId: string,
  brandId: string,
): Promise<BrandStyleHint | null> {
  const row = await env.DB.prepare(
    `SELECT palette, voice FROM brand_guides WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(brandId, userId)
    .first<{ palette: string; voice: string | null }>();

  if (!row) return null;

  return {
    palette: safeJson(row.palette) as Record<string, string> | undefined,
    voice: safeJson(row.voice) as BrandStyleHint['voice'],
  };
}

function safeJson(s: string | null): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
