/**
 * @agentbuilder/core
 *
 * Shared primitives every agent in the fleet depends on:
 *  - Logger with structured JSON output (works in Workers + Node)
 *  - AgentError base class with stable error codes
 *  - AgentContext: the common shape passed through agent request handling
 *  - Result<T,E> helper for flows where throwing is undesirable
 */

export * from './logger.js';
export * from './errors.js';
export * from './context.js';
export * from './result.js';
