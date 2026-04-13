/**
 * Typed error primitives. Every agent surface-level error should extend
 * AgentError so callers can branch on `code` without string-matching messages.
 */

export type AgentErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'rate_limited'
  | 'upstream_failure'
  | 'tool_failure'
  | 'internal';

export interface AgentErrorOptions {
  code: AgentErrorCode;
  status?: number;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, opts: AgentErrorOptions) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AgentError';
    this.code = opts.code;
    this.status = opts.status ?? defaultStatusForCode(opts.code);
    this.details = opts.details;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
    };
  }
}

function defaultStatusForCode(code: AgentErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'invalid_input':
      return 400;
    case 'rate_limited':
      return 429;
    case 'upstream_failure':
      return 502;
    case 'tool_failure':
      return 500;
    case 'internal':
      return 500;
  }
}
