/**
 * HTMLRewriter-based article extractor for paywall-replay watchers
 * (medium-watcher, wired-watcher, and friends).
 *
 * Strategy:
 *   - Stream the page through HTMLRewriter
 *   - Collect <title>, og: meta, JSON-LD Article/NewsArticle/BlogPosting
 *   - Walk <article> body collecting text from block-level descendants,
 *     skipping nav/footer/aside/script/style/etc.
 *   - Resolve fields with fallback chain: JSON-LD → og: → meta → <title>
 *
 * The watcher layer owns: cookie replay, fetch, and downstream forwarding.
 * This module is pure HTML → ExtractedArticle.
 */

export interface ExtractedArticle {
  title:        string | null;
  author:       string | null;
  publishedAt:  string | null;
  fullText:     string;
  canonicalUrl: string | null;
}

const SKIP_TAGS = [
  'script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header',
  'aside', 'form', 'button', 'iframe', 'figure',
];

const BLOCK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'blockquote', 'pre',
];

interface Acc {
  title:        string | null;
  ogTitle:      string | null;
  author:       string | null;
  publishedAt:  string | null;
  canonicalUrl: string | null;
  jsonLdBuf:    string;
  inJsonLd:     boolean;
  jsonLdBlocks: string[];
  inArticle:    boolean;
  skipDepth:    number;
  bodyLines:    string[];
  current:      string;
  inTitleEl:    boolean;
}

export async function extractArticle(html: string, url: string): Promise<ExtractedArticle> {
  const acc: Acc = {
    title: null, ogTitle: null, author: null, publishedAt: null, canonicalUrl: null,
    jsonLdBuf: '', inJsonLd: false, jsonLdBlocks: [],
    inArticle: false, skipDepth: 0, bodyLines: [], current: '', inTitleEl: false,
  };

  let rewriter = new HTMLRewriter()
    .on('title', {
      element() { acc.inTitleEl = true; },
      text(c)   { if (acc.inTitleEl) acc.title = (acc.title ?? '') + c.text; },
    })
    .on('link[rel="canonical"]', {
      element(el) { acc.canonicalUrl = el.getAttribute('href'); },
    })
    .on('meta', {
      element(el) {
        const prop = el.getAttribute('property')?.toLowerCase() ?? '';
        const name = el.getAttribute('name')?.toLowerCase() ?? '';
        const content = el.getAttribute('content') ?? '';
        if (!content) return;
        if (prop === 'og:title')                            acc.ogTitle     = content;
        if (prop === 'article:author' || name === 'author') acc.author      = content;
        if (prop === 'article:published_time')              acc.publishedAt = content;
      },
    })
    .on('script[type="application/ld+json"]', {
      element() { acc.inJsonLd = true; acc.jsonLdBuf = ''; },
      text(c) {
        if (!acc.inJsonLd) return;
        acc.jsonLdBuf += c.text;
        if (c.lastInTextNode) {
          acc.jsonLdBlocks.push(acc.jsonLdBuf);
          acc.inJsonLd = false;
          acc.jsonLdBuf = '';
        }
      },
    })
    .on('article', {
      element(el) {
        acc.inArticle = true;
        el.onEndTag(() => { acc.inArticle = false; });
      },
    });

  rewriter = rewriter.on(SKIP_TAGS.join(','), {
    element(el) {
      if (!acc.inArticle) return;
      acc.skipDepth++;
      el.onEndTag(() => { acc.skipDepth = Math.max(0, acc.skipDepth - 1); });
    },
  });

  rewriter = rewriter.on(BLOCK_TAGS.join(','), {
    element(el) {
      if (!acc.inArticle || acc.skipDepth > 0) return;
      acc.current = '';
      el.onEndTag(() => {
        if (!acc.inArticle || acc.skipDepth > 0) return;
        const line = acc.current.replace(/\s+/g, ' ').trim();
        if (line.length > 0) acc.bodyLines.push(line);
        acc.current = '';
      });
    },
    text(c) {
      if (!acc.inArticle || acc.skipDepth > 0) return;
      acc.current += c.text;
    },
  });

  await rewriter.transform(new Response(html)).text();

  const jsonLd = parseJsonLd(acc.jsonLdBlocks);
  const title  = (jsonLd.title  ?? acc.ogTitle ?? acc.title ?? null)?.trim() ?? null;
  const author = (jsonLd.author ?? acc.author  ?? null)?.trim() ?? null;
  const publishedAt = normaliseDate(jsonLd.publishedAt ?? acc.publishedAt ?? null);
  const canonicalUrl = acc.canonicalUrl ?? url;
  const fullText = dedupe(acc.bodyLines).join('\n');
  return { title, author, publishedAt, fullText, canonicalUrl };
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (l.length < 3 || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

function normaliseDate(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

interface JsonLdArticle {
  '@type'?:       string | string[];
  headline?:      string;
  author?:        { name?: string } | string | Array<{ name?: string }>;
  datePublished?: string;
}

function parseJsonLd(blocks: string[]): Partial<{ title: string; author: string; publishedAt: string }> {
  const out: Partial<{ title: string; author: string; publishedAt: string }> = {};
  for (const raw of blocks) {
    let data: unknown;
    try { data = JSON.parse(raw.trim()); } catch { continue; }
    const nodes: unknown[] = Array.isArray(data)
      ? data
      : (data as Record<string, unknown>)['@graph']
        ? ((data as Record<string, unknown>)['@graph'] as unknown[])
        : [data];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const n = node as JsonLdArticle;
      const types = Array.isArray(n['@type']) ? n['@type'] : [n['@type'] ?? ''];
      if (!types.some((t) => ['Article', 'NewsArticle', 'BlogPosting', 'TechArticle'].includes(t))) continue;
      if (!out.title && n.headline) out.title = n.headline.trim();
      if (!out.publishedAt && n.datePublished) out.publishedAt = n.datePublished;
      if (!out.author && n.author) {
        if (typeof n.author === 'string') out.author = n.author;
        else if (Array.isArray(n.author)) out.author = n.author[0]?.name ?? undefined;
        else if (typeof n.author === 'object' && n.author.name) out.author = n.author.name;
      }
      if (out.title && out.author && out.publishedAt) return out;
    }
  }
  return out;
}
