import { OPERATIONS_BY_CATEGORY } from './registry/index.js';
import type { CoarseCategory, ParamDef, ToolDef } from './registry/types.js';

interface CoarseToolSpec {
  name: CoarseCategory;
  description: string;
}

const COARSE_TOOLS: CoarseToolSpec[] = [
  {
    name: 'markets',
    description:
      'Equities, crypto, commodities, treasury, CFTC, congressional trading, on-chain, and sentiment.',
  },
  {
    name: 'geopolitics',
    description: 'Intelligence, conflict events, military movements, unrest, displacement.',
  },
  { name: 'news', description: 'RSS-backed news digests by variant (full/tech/finance) and locale.' },
  {
    name: 'climate',
    description: 'Weather, agriculture, wildfire, and seismology (earthquakes).',
  },
  {
    name: 'supply_chain',
    description: 'Supply-chain signals, maritime traffic, and trade-flow data.',
  },
  {
    name: 'cyber_infra',
    description: 'Cyber incidents, critical-infrastructure alerts, aviation events.',
  },
  {
    name: 'government',
    description: 'Government releases, SEC EDGAR filings, economic-calendar entries.',
  },
  { name: 'predictions', description: 'Prediction-market odds and forecasting signals.' },
];

export interface McpToolSchema {
  name: CoarseCategory;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export const MCP_TOOLS: McpToolSchema[] = COARSE_TOOLS.map((t) => buildSchema(t));

function buildSchema(spec: CoarseToolSpec): McpToolSchema {
  const ops = OPERATIONS_BY_CATEGORY[spec.name];
  const opNames = ops.map((o) => o.name);

  const properties: Record<string, unknown> = {
    operation: {
      type: 'string',
      description:
        opNames.length > 0
          ? `Specific operation to run. ${describeOps(ops)}`
          : 'No operations are wired for this category yet in v1. Calling will return a 501.',
      ...(opNames.length > 0 ? { enum: opNames } : {}),
    },
    params: {
      type: 'object',
      description: 'Operation-specific parameters. See the operation description for shape.',
      additionalProperties: true,
    },
  };

  return {
    name: spec.name,
    description: `${spec.description} Call with operation + params.`,
    inputSchema: {
      type: 'object',
      properties,
      required: ['operation'],
      additionalProperties: false,
    },
  };
}

function describeOps(tools: ToolDef[]): string {
  return tools
    .map((t) => {
      const p = paramSummary(t.params);
      return `${t.name}${p ? ` (${p})` : ''}: ${t.description}`;
    })
    .join(' | ');
}

function paramSummary(params: Record<string, ParamDef> | undefined): string {
  if (!params) return '';
  return Object.entries(params)
    .map(([k, v]) => `${k}${v.required ? '*' : ''}:${v.type}`)
    .join(', ');
}
