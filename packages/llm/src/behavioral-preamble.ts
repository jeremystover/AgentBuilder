/**
 * Universal behavioral preamble shared by every agent's system prompt.
 *
 * Just the four one-line headers from CLAUDE.md (Karpathy-derived). The
 * full guidance with bullets lives in /CLAUDE.md at the repo root — that's
 * where Claude Code coding sessions read it. Runtime agents only need the
 * headers; embedding the full bullet lists would bloat every system prompt
 * and most of the bullets are coding-task specific anyway.
 *
 * Usage:
 *
 *   import { CORE_BEHAVIORAL_PREAMBLE } from '@agentbuilder/llm';
 *   const SYSTEM = `${CORE_BEHAVIORAL_PREAMBLE}\n\nYou are ...`;
 *
 * Stable on purpose so prompt caching keeps working.
 */
export const CORE_BEHAVIORAL_PREAMBLE = `# Core behavioral guidelines

- Don't assume. Don't hide confusion. Surface tradeoffs.
- Minimum code/output that solves the problem. Nothing speculative.
- Touch only what you must. Clean up only your own mess.
- Define success criteria. Loop until verified.`;
