/**
 * Graphic Designer — app-agent Worker entrypoint.
 *
 * Routes:
 *   GET  /health    -> { status: 'ok', agent: 'graphic-designer' }
 *   GET  /*         -> static assets from ./public
 *   POST /api/*     -> Durable Object (REST API for the app UI)
 *   POST /mcp       -> JSON-RPC 2.0 MCP server (Claude custom tool integration)
 *
 * See ./SKILL.md for the full persona, tools, and non-goals.
 */

import type { Env } from '../worker-configuration';
import { handleOAuthCallback, handleOAuthStart } from './lib/oauth.js';
export { GraphicDesignerDO } from './durable-object.js';

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requireAuth(
  request: Request,
  env: Env,
): { ok: true } | { ok: false; response: Response } {
  const expected = env.MCP_HTTP_KEY ?? '';
  if (!expected) return { ok: true };

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? new URL(request.url).searchParams.get('key') ?? '';

  if (token && token === expected) return { ok: true };
  return { ok: false, response: jsonResponse({ error: 'Unauthorized' }, 401) };
}

// ── MCP tool definitions ─────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'chat',
    description:
      'Conversational design session. Use for logo interviews, presentation planning discussions, and iterative feedback. Pass sessionId back on follow-up turns to maintain context.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Your message.' },
        sessionId: { type: 'string', description: 'Session id for conversation continuity. Omit to start new.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'analyze_template',
    description:
      'Inspect a Google Slides template deck. Maps each master/layout to slot types (title, bullets, image, quote, big-number), text capacity, and best-fit content intents. Stores analysis in D1 for reuse by plan_presentation.',
    inputSchema: {
      type: 'object',
      properties: {
        presentationId: { type: 'string', description: 'Google Slides presentation ID or full URL.' },
        brandId: { type: 'string', description: 'Optional brand_id to associate this template with.' },
      },
      required: ['presentationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_presentation',
    description:
      'Given a content outline and an analyzed template, propose a slide-by-slide breakdown: story arc, layout per slide, text allocation, image/icon needs, and speaker-notes beats. Returns a reviewable plan for user approval before building.',
    inputSchema: {
      type: 'object',
      properties: {
        outline: { type: 'string', description: 'Content outline or key points to present.' },
        templateId: { type: 'string', description: 'Google Slides template ID (must be analyzed first).' },
        brandId: { type: 'string', description: 'Optional brand_id for style constraints.' },
        audience: { type: 'string', description: 'Who will see this deck (e.g. "investors", "internal team").' },
        goal: { type: 'string', description: 'What the presentation should achieve.' },
      },
      required: ['outline', 'templateId'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_presentation',
    description:
      'Execute an approved presentation plan. Duplicates slides from template, populates text (auto-resize/reposition), sources images/icons via search_media, inserts media, writes speaker notes. Returns a Google Drive URL to the finished deck.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'ID of the approved plan from plan_presentation.' },
        title: { type: 'string', description: 'Title for the new presentation.' },
        folderId: { type: 'string', description: 'Optional Google Drive folder ID to create the deck in.' },
      },
      required: ['planId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_media',
    description:
      'Unified image/icon search. Searches Unsplash + Pexels (photos) and Iconify (icons). Falls back to OpenAI gpt-image-1 for AI-generated images when stock results are insufficient. Constrained by style-guide spec if a brandId is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query describing the desired image or icon.' },
        type: { type: 'string', enum: ['photo', 'icon', 'illustration', 'any'], description: 'Media type to search for. Defaults to "any".' },
        brandId: { type: 'string', description: 'Optional brand_id to constrain results by style guide (palette, mood).' },
        count: { type: 'number', description: 'Number of results to return. Defaults to 5.' },
        generateFallback: { type: 'boolean', description: 'If true, generate an AI image via OpenAI if stock search yields poor results.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_brand_compliance',
    description:
      'Audit a Google Doc or Slides file against a stored brand style guide. Checks colors, fonts, logo usage, spacing, and tone. Produces a report with specific violations and suggested fixes.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Google Drive file ID of the Doc or Slides to audit.' },
        brandId: { type: 'string', description: 'Brand ID whose style guide to check against.' },
      },
      required: ['fileId', 'brandId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_site',
    description:
      'Given a content outline and brand guide, propose information architecture (pages), section blocks per page, visual language (type scale, grid, color tokens), and asset needs. Returns a reviewable plan for user approval before building.',
    inputSchema: {
      type: 'object',
      properties: {
        outline: { type: 'string', description: 'Content outline for the website.' },
        brandId: { type: 'string', description: 'Optional brand_id for style constraints.' },
        siteType: { type: 'string', enum: ['landing', 'multi-page', 'portfolio', 'docs'], description: 'Type of site. Defaults to "landing".' },
        audience: { type: 'string', description: 'Target audience for the site.' },
      },
      required: ['outline'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_and_deploy_site',
    description:
      'Generate static HTML/CSS (Tailwind) from an approved site plan, source media via search_media, and deploy to Cloudflare Pages via Direct Upload API. Accepts iteration feedback and re-deploys. Returns the live URL.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'ID of the approved plan from plan_site.' },
        projectName: { type: 'string', description: 'Cloudflare Pages project name (kebab-case).' },
        feedback: { type: 'string', description: 'Iteration feedback for an existing deployment (e.g. "make hero more spacious").' },
        deploymentId: { type: 'string', description: 'Existing deployment ID when iterating on a previous build.' },
      },
      required: ['planId', 'projectName'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_logo_concepts',
    description:
      'From a design brief (gathered via chat interview), produce 6-10 distinct logo concepts spanning mark/wordmark/combo and literal/abstract styles. Uses OpenAI gpt-image-1. Returns a concept gallery with preview URLs. Use the chat tool first to conduct the logo interview.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID from the logo interview chat (contains the design brief).' },
        count: { type: 'number', description: 'Number of concepts to generate. Defaults to 6.' },
        styles: {
          type: 'array',
          items: { type: 'string', enum: ['mark', 'wordmark', 'combo', 'lettermark', 'emblem'] },
          description: 'Logo styles to include. Defaults to all.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'finalize_logo_package',
    description:
      'From a chosen logo concept, produce the full export set: SVG master, PNG at 512/1024/2048, monochrome + reversed variants, favicon.ico, social avatars. Drafts a matching brand style guide (palette, type pairings, voice, spacing). Saves to R2 + Google Drive folder.',
    inputSchema: {
      type: 'object',
      properties: {
        conceptId: { type: 'string', description: 'ID of the selected logo concept from generate_logo_concepts.' },
        companyName: { type: 'string', description: 'Company/brand name for the style guide.' },
        folderId: { type: 'string', description: 'Optional Google Drive folder ID to save the package to.' },
      },
      required: ['conceptId', 'companyName'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_brand_assets',
    description:
      'CRUD for stored brand guides, template decks, logo packages, and completed project history. Lets other tools reference brand_id without re-uploading each call.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], description: 'CRUD action.' },
        assetType: { type: 'string', enum: ['brand_guide', 'template', 'logo_package', 'project'], description: 'Type of asset.' },
        id: { type: 'string', description: 'Asset ID (required for get/update/delete).' },
        data: { type: 'object', description: 'Asset data (for create/update).' },
      },
      required: ['action', 'assetType'],
      additionalProperties: false,
    },
  },
  {
    name: 'canva_export',
    description:
      'Export a logo package or brand assets to Canva via the Canva Connect API. Creates a Canva Brand Kit with colors, fonts, and logo files. Use this as a post-production step after finalize_logo_package.',
    inputSchema: {
      type: 'object',
      properties: {
        brandId: { type: 'string', description: 'Brand ID whose assets to export to Canva.' },
        includeLogos: { type: 'boolean', description: 'Include logo files in the export. Defaults to true.' },
        includeColors: { type: 'boolean', description: 'Include brand colors. Defaults to true.' },
        includeFonts: { type: 'boolean', description: 'Include font specifications. Defaults to true.' },
      },
      required: ['brandId'],
      additionalProperties: false,
    },
  },
];

// ── JSON-RPC 2.0 MCP handler ─────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));

async function handleMcp(
  message: JsonRpcMessage,
  env: Env,
  originalRequest: Request,
): Promise<unknown> {
  const { id, method, params } = message;

  if (!method) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'graphic-designer', version: '0.1.0' },
        instructions:
          'Graphic Designer agent. Designs and produces visual artifacts — Google Slides from templates, Cloudflare Pages websites, logos + brand guides, image/icon sourcing, and brand-compliance audits.',
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (method === 'tools/call') {
    const toolName = String(params?.name ?? '');
    if (!TOOL_NAMES.has(toolName)) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
    }

    const args = (params?.arguments ?? {}) as Record<string, unknown>;

    const doKey = (args.sessionId as string) ?? crypto.randomUUID();
    const doId = env.AGENT_DO.idFromName(doKey);
    const stub = env.AGENT_DO.get(doId);

    const doRequest = new Request(originalRequest.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: toolName, args, sessionId: doKey }),
    });

    const doResponse = await stub.fetch(doRequest);
    if (!doResponse.ok) {
      const text = await doResponse.text();
      return { jsonrpc: '2.0', id, error: { code: -32000, message: text } };
    }

    const result = (await doResponse.json()) as Record<string, unknown>;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      },
    };
  }

  if (method === 'notifications/initialized') return null;

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── Worker ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ status: 'ok', agent: 'graphic-designer' });
    }

    if (url.pathname === '/api/auth/google/start') {
      return handleOAuthStart(request, env);
    }
    if (url.pathname === '/api/auth/google/callback') {
      return handleOAuthCallback(request, env);
    }

    if (url.pathname === '/mcp' && request.method === 'POST') {
      const auth = requireAuth(request, env);
      if (!auth.ok) return auth.response;

      let msg: JsonRpcMessage;
      try {
        msg = (await request.json()) as JsonRpcMessage;
      } catch {
        return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }

      try {
        const out = await handleMcp(msg, env, request);
        if (out === null) return new Response(null, { status: 204 });
        return jsonResponse(out);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return jsonResponse({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: errMsg } });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const doId = env.AGENT_DO.idFromName('global');
      const stub = env.AGENT_DO.get(doId);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
