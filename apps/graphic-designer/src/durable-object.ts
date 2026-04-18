import { DurableObject } from 'cloudflare:workers';
import { AgentError, createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../worker-configuration';
import { analyzeTemplate, type AnalyzeTemplateArgs } from './tools/analyze-template.js';
import {
  buildPresentation,
  type BuildPresentationArgs,
} from './tools/build-presentation.js';
import { canvaExport, type CanvaExportArgs } from './tools/canva-export.js';
import {
  finalizeLogoPackage,
  type FinalizeLogoPackageArgs,
} from './tools/finalize-logo-package.js';
import {
  generateLogoConcepts,
  type GenerateLogoConceptsArgs,
} from './tools/generate-logo-concepts.js';
import {
  manageBrandAssets,
  type ManageBrandAssetsArgs,
} from './tools/manage-brand-assets.js';
import {
  planPresentation,
  type PlanPresentationArgs,
} from './tools/plan-presentation.js';
import { searchMedia, type SearchMediaArgs } from './tools/search-media.js';

const SYSTEM_PROMPT = `You are Graphic Designer, a creative design agent.

You help users create professional visual artifacts:
- Google Slides presentations from templates
- Logos with iterative refinement
- Static websites deployed to Cloudflare Pages
- Brand style guides
- Image and icon sourcing

You are currently in a design session. When conducting a logo interview, gather:
industry, target audience, mood words (3-5), color preferences, company name,
tagline (if any), inspirations, and anything to avoid. Summarize the brief
before generating concepts.

For presentations, understand the story arc and audience before recommending
slide layouts. Always explain your reasoning.`;

interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
}

interface ChatRequest {
  message: string;
  sessionId?: string;
}

export class GraphicDesignerDO extends DurableObject<Env> {
  private readonly llm: LLMClient;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.llm = new LLMClient({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      workersAi: env.AI,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const logger = createLogger({ base: { agent: 'graphic-designer' } });
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = (await request.json()) as ToolRequest | ChatRequest;

    if ('tool' in body) {
      return this.handleToolCall(body, logger);
    }

    if (url.pathname === '/api/chat' || 'message' in body) {
      return this.handleChat(body as ChatRequest, logger);
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleChat(
    req: ChatRequest,
    logger: ReturnType<typeof createLogger>,
  ): Promise<Response> {
    const sessionId = req.sessionId ?? crypto.randomUUID();
    logger.info('chat.turn', { sessionId });

    const history = await this.loadChatHistory(sessionId);
    const messages = [...history, { role: 'user' as const, content: req.message }];

    const res = await this.llm.complete({
      tier: 'default',
      system: SYSTEM_PROMPT,
      messages,
    });

    await this.appendChatMessages(sessionId, [
      { role: 'user', content: req.message },
      { role: 'assistant', content: res.text },
    ]);

    return Response.json({
      reply: res.text,
      sessionId,
      usage: res.usage,
    });
  }

  private async loadChatHistory(
    sessionId: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const rows = await this.env.DB.prepare(
      `SELECT role, content FROM chat_messages
        WHERE session_id = ?1
        ORDER BY created_at ASC
        LIMIT 40`,
    )
      .bind(sessionId)
      .all<{ role: string; content: string }>();
    return (rows.results ?? [])
      .filter((r): r is { role: 'user' | 'assistant'; content: string } =>
        r.role === 'user' || r.role === 'assistant',
      );
  }

  private async appendChatMessages(
    sessionId: string,
    turns: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  ): Promise<void> {
    const now = Date.now();
    const stmt = this.env.DB.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    );
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (!turn) continue;
      await stmt
        .bind(`msg_${crypto.randomUUID()}`, sessionId, turn.role, turn.content, now + i)
        .run();
    }
  }

  private async handleToolCall(
    req: ToolRequest,
    logger: ReturnType<typeof createLogger>,
  ): Promise<Response> {
    logger.info(`tool.${req.tool}`);

    try {
      switch (req.tool) {
        case 'chat':
          return this.handleChat(
            { message: req.args.message as string, sessionId: req.sessionId },
            logger,
          );

        case 'manage_brand_assets': {
          const result = await manageBrandAssets(
            this.env,
            req.args as unknown as ManageBrandAssetsArgs,
          );
          return Response.json({ ...result, sessionId: req.sessionId });
        }

        case 'analyze_template': {
          const result = await analyzeTemplate(
            this.env,
            req.args as unknown as AnalyzeTemplateArgs,
          );
          return Response.json({ ...result, sessionId: req.sessionId });
        }

        case 'search_media': {
          const result = await searchMedia(
            this.env,
            req.args as unknown as SearchMediaArgs,
          );
          return Response.json({ ...result, sessionId: req.sessionId });
        }

        case 'plan_presentation': {
          const result = await planPresentation(
            this.env,
            req.args as unknown as PlanPresentationArgs,
          );
          return Response.json({ ...result, sessionId: req.sessionId });
        }

        case 'build_presentation': {
          const result = await buildPresentation(
            this.env,
            req.args as unknown as BuildPresentationArgs,
          );
          return Response.json({ ...result, sessionId: req.sessionId });
        }

        case 'generate_logo_concepts': {
          const args = req.args as unknown as GenerateLogoConceptsArgs;
          // Default to the current DO session if caller didn't pass one.
          const result = await generateLogoConcepts(this.env, {
            ...args,
            sessionId: args.sessionId ?? req.sessionId,
          });
          return Response.json({ ...result, sessionId: req.sessionId });
        }

        case 'finalize_logo_package': {
          const result = await finalizeLogoPackage(
            this.env,
            req.args as unknown as FinalizeLogoPackageArgs,
          );
          return Response.json({ ...result, sessionId: req.sessionId });
        }

        case 'canva_export': {
          const result = await canvaExport(
            this.env,
            req.args as unknown as CanvaExportArgs,
          );
          return Response.json({ ...result, sessionId: req.sessionId });
        }

        case 'check_brand_compliance':
        case 'plan_site':
        case 'build_and_deploy_site':
          return Response.json({
            ok: false,
            status: 'not_implemented',
            tool: req.tool,
            message: `Tool "${req.tool}" is registered but not yet implemented. Coming in Slice 4b-4c.`,
            sessionId: req.sessionId,
          });

        default:
          return new Response(`Unknown tool: ${req.tool}`, { status: 400 });
      }
    } catch (err) {
      if (err instanceof AgentError) {
        logger.warn(`tool.${req.tool}.error`, { code: err.code, message: err.message });
        return Response.json(
          { ok: false, error: err.message, code: err.code, sessionId: req.sessionId },
          { status: err.status },
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`tool.${req.tool}.unexpected`, { message });
      return Response.json(
        { ok: false, error: message, sessionId: req.sessionId },
        { status: 500 },
      );
    }
  }
}
