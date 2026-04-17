export type ParamType = 'string' | 'number' | 'boolean' | 'string[]';

export interface ParamDef {
  type: ParamType;
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  enum?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  params?: Record<string, ParamDef>;
  endpoint: string;
  method?: 'GET' | 'POST';
}

export interface ServiceDef {
  name: string;
  description: string;
  basePath: string;
  tools: ToolDef[];
}

export type CoarseCategory =
  | 'markets'
  | 'geopolitics'
  | 'news'
  | 'climate'
  | 'supply_chain'
  | 'cyber_infra'
  | 'government'
  | 'predictions';

export interface RegistryEntry {
  service: ServiceDef;
  tool: ToolDef;
  category: CoarseCategory;
}
