import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@agentbuilder/core';
import { LLMClient } from '@agentbuilder/llm';
import type { Env } from '../worker-configuration';

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
    logger.info('chat.turn');
    const res = await this.llm.complete({
      tier: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: req.message }],
    });
    return Response.json({
      reply: res.text,
      sessionId: req.sessionId,
      usage: res.usage,
    });
  }

  private async handleToolCall(
    req: ToolRequest,
    logger: ReturnType<typeof createLogger>,
  ): Promise<Response> {
    logger.info(`tool.${req.tool}`);

    switch (req.tool) {
      case 'chat':
        return this.handleChat(
          { message: req.args.message as string, sessionId: req.sessionId },
          logger,
        );

      case 'analyze_template':
      case 'plan_presentation':
      case 'build_presentation':
      case 'search_media':
      case 'check_brand_compliance':
      case 'plan_site':
      case 'build_and_deploy_site':
      case 'generate_logo_concepts':
      case 'finalize_logo_package':
      case 'manage_brand_assets':
      case 'canva_export':
        return Response.json({
          status: 'not_implemented',
          tool: req.tool,
          message: `Tool "${req.tool}" is registered but not yet implemented. Coming in Slice 2-4.`,
          sessionId: req.sessionId,
        });

      default:
        return new Response(`Unknown tool: ${req.tool}`, { status: 400 });
    }
  }
}
