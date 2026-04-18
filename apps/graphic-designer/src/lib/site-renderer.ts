/**
 * Static HTML renderer for a site plan.
 *
 * Inputs a validated plan (pages + sections + visual language) and produces
 * a file map { path -> content } suitable for Cloudflare Pages upload.
 *
 * Uses Tailwind via the JIT CDN (play.tailwindcss.com / cdn.tailwindcss.com)
 * with CSS custom properties for the brand palette. This keeps the output
 * self-contained — no build step required.
 */

import type { SitePage, SiteSection, VisualLanguage } from '../tools/plan-site.js';

export interface RenderInput {
  title: string;
  pages: SitePage[];
  visualLanguage: VisualLanguage;
  mediaUrls: Map<string, string>;              // sectionId -> resolved media URL
}

export interface RenderedSite {
  files: Map<string, { content: string | Uint8Array; contentType: string }>;
}

export function renderSite(input: RenderInput): RenderedSite {
  const files = new Map<string, { content: string | Uint8Array; contentType: string }>();

  for (const page of input.pages) {
    const html = renderPage(page, input);
    const path = page.slug === 'index' ? '/index.html' : `/${page.slug}/index.html`;
    files.set(path, { content: html, contentType: 'text/html; charset=utf-8' });
  }

  files.set('/_headers', {
    content: `/*\n  Cache-Control: public, max-age=3600\n  X-Content-Type-Options: nosniff\n`,
    contentType: 'text/plain',
  });

  files.set('/robots.txt', {
    content: 'User-agent: *\nAllow: /\n',
    contentType: 'text/plain',
  });

  return { files };
}

// ── Page rendering ─────────────────────────────────────────────────────────

function renderPage(page: SitePage, input: RenderInput): string {
  const sectionsHtml = page.sections.map((s) => renderSection(s, input, page)).join('\n');
  const paletteVars = paletteToCss(input.visualLanguage.palette);
  const heading = escapeHtml(input.visualLanguage.typography.heading);
  const body = escapeHtml(input.visualLanguage.typography.body);
  const fonts = `${encodeURIComponent(heading)}&family=${encodeURIComponent(body)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=${fonts}&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
${paletteVars}
    }
    body { font-family: '${body}', system-ui, sans-serif; color: var(--color-text); background: var(--color-bg); }
    h1, h2, h3, h4, h5, h6 { font-family: '${heading}', system-ui, sans-serif; }
    .btn-primary { background: var(--color-primary); color: var(--color-bg); }
    .btn-primary:hover { opacity: 0.9; }
    .accent { color: var(--color-accent); }
    .muted { color: var(--color-muted); }
  </style>
</head>
<body class="antialiased">
${sectionsHtml}
</body>
</html>
`;
}

// ── Section rendering ──────────────────────────────────────────────────────

function renderSection(section: SiteSection, input: RenderInput, page: SitePage): string {
  const mediaUrl = input.mediaUrls.get(section.id);

  switch (section.block) {
    case 'header':
      return renderHeader(section, input.pages, page.slug);
    case 'hero':
      return renderHero(section, mediaUrl, input.visualLanguage);
    case 'features':
      return renderFeatures(section);
    case 'testimonials':
      return renderTestimonials(section);
    case 'cta':
      return renderCta(section);
    case 'text':
      return renderText(section);
    case 'gallery':
      return renderGallery(section);
    case 'contact':
      return renderContact(section);
    case 'footer':
      return renderFooter(section);
    default:
      return '';
  }
}

function renderHeader(section: SiteSection, allPages: SitePage[], currentSlug: string): string {
  const navLinks = allPages
    .map((p) => {
      const href = p.slug === 'index' ? '/' : `/${p.slug}/`;
      const active = p.slug === currentSlug ? 'font-semibold' : '';
      return `<a href="${href}" class="hover:opacity-70 ${active}">${escapeHtml(p.title)}</a>`;
    })
    .join('');

  return `<header class="border-b" style="border-color: var(--color-muted)">
  <div class="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
    <a href="/" class="text-xl font-bold">${escapeHtml(section.headline ?? 'Home')}</a>
    <nav class="flex gap-6 text-sm">${navLinks}</nav>
  </div>
</header>`;
}

function renderHero(section: SiteSection, mediaUrl: string | undefined, vl: VisualLanguage): string {
  const bg = mediaUrl
    ? `style="background-image: linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.45)), url('${escapeAttr(mediaUrl)}'); background-size: cover; background-position: center; color: white;"`
    : '';
  const textClass = mediaUrl ? 'text-white' : '';

  const cta = section.cta
    ? `<a href="${escapeAttr(section.cta.href)}" class="inline-block mt-8 px-6 py-3 rounded-lg font-semibold btn-primary">${escapeHtml(section.cta.label)}</a>`
    : '';

  return `<section id="${escapeAttr(section.id)}" class="py-24 px-6 ${textClass}" ${bg}>
  <div class="max-w-4xl mx-auto text-center">
    <h1 class="text-5xl md:text-6xl font-bold mb-6">${escapeHtml(section.headline ?? '')}</h1>
    ${section.subhead ? `<p class="text-xl md:text-2xl ${mediaUrl ? '' : 'muted'}">${escapeHtml(section.subhead)}</p>` : ''}
    ${cta}
  </div>
</section>`;
}

function renderFeatures(section: SiteSection): string {
  const items = (section.items ?? [])
    .map(
      (item) => `
  <div class="p-6 rounded-xl border" style="border-color: var(--color-muted)">
    <h3 class="text-xl font-semibold mb-3 accent">${escapeHtml(item.title)}</h3>
    <p class="muted">${escapeHtml(item.body)}</p>
  </div>`,
    )
    .join('');

  return `<section id="${escapeAttr(section.id)}" class="py-20 px-6">
  <div class="max-w-6xl mx-auto">
    ${section.headline ? `<h2 class="text-4xl font-bold text-center mb-4">${escapeHtml(section.headline)}</h2>` : ''}
    ${section.subhead ? `<p class="text-lg text-center mb-12 muted max-w-2xl mx-auto">${escapeHtml(section.subhead)}</p>` : ''}
    <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">${items}</div>
  </div>
</section>`;
}

function renderTestimonials(section: SiteSection): string {
  const items = (section.items ?? [])
    .map(
      (item) => `
  <blockquote class="p-8 rounded-xl border" style="border-color: var(--color-muted)">
    <p class="text-lg mb-4">"${escapeHtml(item.body)}"</p>
    <cite class="block text-sm font-semibold accent">— ${escapeHtml(item.title)}</cite>
  </blockquote>`,
    )
    .join('');

  return `<section id="${escapeAttr(section.id)}" class="py-20 px-6" style="background: color-mix(in srgb, var(--color-accent) 5%, var(--color-bg))">
  <div class="max-w-5xl mx-auto">
    ${section.headline ? `<h2 class="text-4xl font-bold text-center mb-12">${escapeHtml(section.headline)}</h2>` : ''}
    <div class="grid md:grid-cols-2 gap-6">${items}</div>
  </div>
</section>`;
}

function renderCta(section: SiteSection): string {
  const cta = section.cta
    ? `<a href="${escapeAttr(section.cta.href)}" class="inline-block mt-6 px-8 py-4 rounded-lg font-semibold btn-primary text-lg">${escapeHtml(section.cta.label)}</a>`
    : '';

  return `<section id="${escapeAttr(section.id)}" class="py-24 px-6 text-center" style="background: var(--color-primary); color: var(--color-bg);">
  <div class="max-w-3xl mx-auto">
    <h2 class="text-4xl md:text-5xl font-bold mb-4">${escapeHtml(section.headline ?? '')}</h2>
    ${section.subhead ? `<p class="text-xl opacity-90">${escapeHtml(section.subhead)}</p>` : ''}
    ${cta}
  </div>
</section>`;
}

function renderText(section: SiteSection): string {
  const body = section.body ? markdownLite(section.body) : '';
  return `<section id="${escapeAttr(section.id)}" class="py-16 px-6">
  <div class="max-w-3xl mx-auto prose">
    ${section.headline ? `<h2 class="text-3xl font-bold mb-6">${escapeHtml(section.headline)}</h2>` : ''}
    <div class="text-lg leading-relaxed">${body}</div>
  </div>
</section>`;
}

function renderGallery(section: SiteSection): string {
  const items = (section.items ?? [])
    .map(
      (item) => `
  <article class="group">
    <div class="aspect-video rounded-lg overflow-hidden mb-4" style="background: var(--color-muted)"></div>
    <h3 class="text-lg font-semibold mb-2">${escapeHtml(item.title)}</h3>
    <p class="text-sm muted">${escapeHtml(item.body)}</p>
  </article>`,
    )
    .join('');

  return `<section id="${escapeAttr(section.id)}" class="py-20 px-6">
  <div class="max-w-6xl mx-auto">
    ${section.headline ? `<h2 class="text-4xl font-bold mb-12">${escapeHtml(section.headline)}</h2>` : ''}
    <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-8">${items}</div>
  </div>
</section>`;
}

function renderContact(section: SiteSection): string {
  return `<section id="${escapeAttr(section.id)}" class="py-20 px-6">
  <div class="max-w-xl mx-auto text-center">
    ${section.headline ? `<h2 class="text-3xl font-bold mb-4">${escapeHtml(section.headline)}</h2>` : ''}
    ${section.body ? `<p class="text-lg muted mb-8">${escapeHtml(section.body)}</p>` : ''}
    ${section.cta ? `<a href="${escapeAttr(section.cta.href)}" class="inline-block px-6 py-3 rounded-lg font-semibold btn-primary">${escapeHtml(section.cta.label)}</a>` : ''}
  </div>
</section>`;
}

function renderFooter(section: SiteSection): string {
  return `<footer class="py-12 px-6 border-t" style="border-color: var(--color-muted)">
  <div class="max-w-6xl mx-auto text-center text-sm muted">
    ${section.body ? escapeHtml(section.body) : `&copy; ${new Date().getFullYear()} ${escapeHtml(section.headline ?? '')}`}
  </div>
</footer>`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function paletteToCss(palette: Record<string, string>): string {
  const entries = Object.entries(palette);
  const fallbacks: Record<string, string> = {
    primary: '#111111', accent: '#2563eb', bg: '#ffffff', text: '#111111', muted: '#6b7280',
  };
  const merged = { ...fallbacks, ...palette };
  return Object.entries(merged)
    .map(([k, v]) => `      --color-${kebab(k)}: ${v};`)
    .join('\n') + (entries.length === 0 ? '' : '');
}

function kebab(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Tiny markdown — supports paragraphs, bullets, and **bold**. That's all we need.
function markdownLite(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) { out.push('<ul class="list-disc list-inside space-y-2">'); inList = true; }
      out.push(`<li>${inlineMd(line.slice(2))}</li>`);
    } else if (line.trim() === '') {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p class="mb-4">${inlineMd(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}
