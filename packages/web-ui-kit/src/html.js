/**
 * web-ui-kit/html — login + SPA shell HTML.
 *
 * Two pages:
 *   loginHtml({ title?, error? })  — minimal password form, posts to /app/login
 *   appHtml({ title? })            — main SPA shell that loads /app/app.js
 *
 * Tailwind via CDN, no build step. Visual style is deliberately consistent
 * across agents: off-white paper background, dark slate text, serif headings
 * (Source Serif), sans body (Inter). Indigo accent for actions, amber for
 * warnings, emerald for success, rose for errors.
 *
 * Per-agent customization is intentionally limited to {title}, an opt-in
 * {head} string for favicons / web-app manifests, and the brand mark in the
 * nav (rendered by the SPA, not here). Resist the urge to expose a theming
 * API — visual consistency across the fleet is the whole point.
 */

const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=Inter:wght@400;500;600&display=swap';
const TAILWIND_CDN = 'https://cdn.tailwindcss.com';

const HEAD_COMMON = `
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link rel="stylesheet" href="${FONTS_HREF}"/>
  <script src="${TAILWIND_CDN}"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            serif: ['"Source Serif 4"', 'Georgia', 'serif'],
            sans:  ['Inter', 'ui-sans-serif', 'system-ui'],
          },
          colors: { paper: '#fbfaf6', ink: '#1f2433' }
        }
      }
    }
  </script>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui; background: #fbfaf6; color: #1f2433; }
    h1, h2, h3 { font-family: 'Source Serif 4', Georgia, serif; letter-spacing: -0.01em; }
    body::before {
      content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
      background-image: radial-gradient(rgba(31,36,51,.025) 1px, transparent 1px);
      background-size: 4px 4px;
    }
    .scrollbar-thin::-webkit-scrollbar { width: 6px; height: 6px; }
    .scrollbar-thin::-webkit-scrollbar-thumb { background: #d6d2c4; border-radius: 3px; }
  </style>
`;

export function loginHtml(opts = {}) {
  const title = opts.title || "Sign in";
  const error = opts.error;
  // Form action defaults to /app/login (vanilla mode — chief-of-staff,
  // template). Agents using a different surface (e.g. The Lab at /lab)
  // pass `action: "/lab/login"` so the browser POSTs to a route the
  // worker actually serves. Without this override the form silently
  // POSTs to /app/login on every agent and 404s with JSON.
  const action = opts.action || "/app/login";
  const head = opts.head || "";
  return `<!doctype html>
<html><head>${HEAD_COMMON}<title>${escapeHtml(title)}</title>${head}</head>
<body class="min-h-screen flex items-center justify-center px-4">
  <div class="relative z-10 w-full max-w-sm">
    <div class="text-center mb-8">
      <div class="text-5xl mb-3">✦</div>
      <h1 class="text-3xl font-semibold">${escapeHtml(title)}</h1>
      <p class="text-sm text-slate-500 mt-2">Sign in to continue</p>
    </div>
    <form method="POST" action="${escapeHtml(action)}" class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200 p-6 space-y-4">
      ${error ? `<div class="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-700">${escapeHtml(error)}</div>` : ''}
      <label class="block">
        <span class="text-xs uppercase tracking-wide text-slate-500">Password</span>
        <input type="password" name="password" autofocus required
          class="mt-1 block w-full rounded-lg ring-1 ring-slate-200 px-3 py-2 focus:ring-indigo-400 focus:outline-none"/>
      </label>
      <button type="submit"
        class="w-full rounded-lg bg-ink text-white py-2.5 text-sm font-medium hover:bg-slate-700 transition">
        Continue
      </button>
    </form>
    <p class="text-center text-xs text-slate-400 mt-6">Single-user · cookie session</p>
  </div>
</body></html>`;
}

export function appHtml(opts = {}) {
  const title = opts.title || "Workspace";
  const head = opts.head || "";
  return `<!doctype html>
<html><head>${HEAD_COMMON}<title>${escapeHtml(title)}</title>${head}</head>
<body class="min-h-screen">
  <div id="app" class="relative z-10"></div>
  <script src="/app/app.js"></script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
