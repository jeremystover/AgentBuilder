/**
 * Content extraction from URLs via HTMLRewriter streaming parse.
 *
 * Strategy:
 *   1. Fetch with browser-like UA headers
 *   2. Stream through HTMLRewriter to collect meta tags + body text
 *   3. Parse JSON-LD for structured article metadata
 *   4. Resolve fields via fallback chain: JSON-LD → og: → meta → <title>
 */

export interface ExtractedContent {
  title:        string | null;
  author:       string | null;
  publishedAt:  string | null;
  fullText:     string;
  html:         string;
  canonicalUrl: string | null;
  lang:         string | null;
}

const FETCH_HEADERS: HeadersInit = {
  "User-Agent": "Mozilla/5.0 (compatible; ContentBrain/1.0; +https://contentbrain.workers.dev)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES   = 5_000_000;

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "li", "td", "th", "dt", "dd", "blockquote",
  "pre", "div", "section", "article", "main",
  "figure", "figcaption",
]);

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "svg", "canvas",
  "nav", "footer", "header", "aside",
  "form", "button", "select", "option",
  "iframe", "object", "embed", "picture",
  "template", "dialog",
]);

interface Acc {
  title:        string | null;
  ogTitle:      string | null;
  ogAuthor:     string | null;
  ogPublished:  string | null;
  canonicalUrl: string | null;
  lang:         string | null;
  metaAuthor:   string | null;
  metaDate:     string | null;
  jsonLdBlocks: string[];
  bodyLines:    string[];
  _inTitleEl:   boolean;
  _inJsonLd:    boolean;
  _jsonLdBuf:   string;
  _skipDepth:   number;
  _inBody:      boolean;
  _currentBlock: string;
}

function makeAcc(): Acc {
  return {
    title: null, ogTitle: null, ogAuthor: null, ogPublished: null,
    canonicalUrl: null, lang: null, metaAuthor: null, metaDate: null,
    jsonLdBlocks: [], bodyLines: [],
    _inTitleEl: false, _inJsonLd: false, _jsonLdBuf: "",
    _skipDepth: 0, _inBody: false, _currentBlock: "",
  };
}

function attachHandlers(rewriter: HTMLRewriter, acc: Acc): HTMLRewriter {
  rewriter.on("html", { element(el) { acc.lang = el.getAttribute("lang") ?? null; } });

  rewriter.on("title", {
    element() { acc._inTitleEl = true; },
    text(chunk) { if (acc._inTitleEl) acc.title = (acc.title ?? "") + chunk.text; },
  });

  rewriter.on('link[rel="canonical"]', {
    element(el) { acc.canonicalUrl = el.getAttribute("href") ?? null; },
  });

  rewriter.on("meta", {
    element(el) {
      const prop    = el.getAttribute("property")?.toLowerCase() ?? "";
      const name    = el.getAttribute("name")?.toLowerCase() ?? "";
      const content = el.getAttribute("content") ?? "";
      if (!content) return;
      if (prop === "og:title")               acc.ogTitle    = content;
      if (prop === "article:author")         acc.ogAuthor   = content;
      if (prop === "article:published_time") acc.ogPublished = content;
      if (name === "author")                 acc.metaAuthor = content;
      if ((name === "date" || name === "pubdate" || name === "dc.date") && !acc.metaDate)
        acc.metaDate = content;
    },
  });

  rewriter.on('script[type="application/ld+json"]', {
    element() { acc._inJsonLd = true; acc._jsonLdBuf = ""; },
    text(chunk) { if (acc._inJsonLd) acc._jsonLdBuf += chunk.text; },
  });

  rewriter.on("body", { element() { acc._inBody = true; } });

  rewriter.on(Array.from(SKIP_TAGS).join(","), {
    element(el) {
      if (!acc._inBody) return;
      acc._skipDepth++;
      el.onEndTag(() => { acc._skipDepth = Math.max(0, acc._skipDepth - 1); });
    },
  });

  rewriter.on(Array.from(BLOCK_TAGS).join(","), {
    element(el) {
      if (!acc._inBody || acc._skipDepth > 0) return;
      acc._currentBlock = "";
      el.onEndTag(() => {
        if (!acc._inBody || acc._skipDepth > 0) return;
        const line = acc._currentBlock.replace(/\s+/g, " ").trim();
        if (line.length > 0) acc.bodyLines.push(line);
        acc._currentBlock = "";
      });
    },
    text(chunk) {
      if (!acc._inBody || acc._skipDepth > 0) return;
      acc._currentBlock += chunk.text;
    },
  });

  return rewriter;
}

interface JsonLdArticle {
  "@type"?:       string | string[];
  headline?:      string;
  name?:          string;
  author?:        { name?: string } | string | Array<{ name?: string }>;
  datePublished?: string;
  description?:   string;
}

function parseJsonLd(blocks: string[]): Partial<{ title: string; author: string; publishedAt: string }> {
  const result: Partial<{ title: string; author: string; publishedAt: string }> = {};

  for (const raw of blocks) {
    let data: unknown;
    try { data = JSON.parse(raw.trim()); } catch { continue; }

    const nodes: unknown[] = Array.isArray(data)
      ? data
      : (data as Record<string, unknown>)["@graph"]
        ? ((data as Record<string, unknown>)["@graph"] as unknown[])
        : [data];

    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as JsonLdArticle;
      const types = Array.isArray(n["@type"]) ? n["@type"] : [n["@type"] ?? ""];
      const isArticle = types.some((t) =>
        ["Article", "NewsArticle", "BlogPosting", "WebPage", "TechArticle"].includes(t),
      );
      if (!isArticle) continue;

      if (!result.title && (n.headline || n.name))
        result.title = (n.headline ?? n.name)!.trim();

      if (!result.publishedAt && n.datePublished)
        result.publishedAt = n.datePublished;

      if (!result.author && n.author) {
        if (typeof n.author === "string") result.author = n.author;
        else if (Array.isArray(n.author)) result.author = n.author[0]?.name ?? "";
        else if (typeof n.author === "object" && n.author.name) result.author = n.author.name;
      }

      if (result.title && result.author && result.publishedAt) break;
    }
    if (result.title && result.author && result.publishedAt) break;
  }

  return result;
}

function normaliseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch { return null; }
}

function assembleText(lines: string[]): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of lines) {
    const n = line.replace(/\s+/g, " ").trim();
    if (n.length < 3 || seen.has(n)) continue;
    seen.add(n);
    unique.push(n);
  }
  return unique.join("\n");
}

export async function extractContent(url: string): Promise<ExtractedContent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { headers: FETCH_HEADERS, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("xhtml")) {
    const text = contentType.startsWith("text/") ? await response.text() : "";
    return { title: null, author: null, publishedAt: null, fullText: text.slice(0, 50_000), html: text.slice(0, 50_000), canonicalUrl: url, lang: null };
  }

  const html = await response.clone().text();
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    throw new Error(`Page too large for ${url}`);
  }

  const acc = makeAcc();
  const rewriter = attachHandlers(new HTMLRewriter(), acc);
  await rewriter.transform(new Response(html)).text();

  if (acc._inJsonLd && acc._jsonLdBuf.trim()) {
    acc.jsonLdBlocks.push(acc._jsonLdBuf);
  }

  const jsonLd = parseJsonLd(acc.jsonLdBlocks);

  const title       = (jsonLd.title ?? acc.ogTitle ?? acc.title ?? null)?.trim() ?? null;
  const author      = (jsonLd.author ?? acc.ogAuthor ?? acc.metaAuthor ?? null)?.trim() ?? null;
  const publishedAt = normaliseDate(jsonLd.publishedAt ?? acc.ogPublished ?? acc.metaDate ?? null);
  const canonicalUrl = (acc.canonicalUrl ?? url).trim() || url;
  const fullText = assembleText(acc.bodyLines);

  return { title, author, publishedAt, fullText, html, canonicalUrl, lang: acc.lang ?? null };
}
