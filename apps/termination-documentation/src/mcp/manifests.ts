/**
 * Tool manifests advertised via MCP `tools/list`.
 *
 * Only tools that are actually wired up in the Durable Object are listed
 * here — the SKILL.md is the roadmap; this file is the runtime truth.
 * Add an entry when the corresponding handler ships.
 */

import { ALL_CATEGORIES, ALL_CLAIM_TYPES } from '../lib/case-state.js';

export const MCP_TOOLS = [
  {
    name: 'intake_interview',
    description:
      'Record facts about the user\'s situation for a possible California wrongful-termination / retaliation / discrimination / harassment / wage-hour / leave claim. Merge any subset of fields; returns remaining intake questions. Not legal advice.',
    inputSchema: {
      type: 'object',
      properties: {
        employer_name: { type: 'string' },
        employer_hq_state: { type: 'string' },
        employer_employee_count: { type: 'integer', minimum: 0 },
        employee_role: { type: 'string' },
        start_date: { type: 'string', description: 'ISO date (YYYY-MM-DD) or a free-form date the user provided.' },
        end_date: { type: 'string', description: 'Termination date, or expected date.' },
        at_will: { type: 'boolean' },
        has_written_contract: { type: 'boolean' },
        has_arbitration_agreement: { type: 'boolean' },
        jurisdiction: { type: 'string', enum: ['CA', 'other', 'unknown'] },
        protected_classes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Free-form labels like "age_40+", "pregnancy", "disability_mental_health".',
        },
        protected_activity: {
          type: 'array',
          items: { type: 'string' },
          description: 'Free-form labels like "reported_harassment", "requested_accommodation", "took_cfra_leave".',
        },
        termination_narrative: {
          type: 'string',
          description: 'Short free-form account: who, when, stated reason.',
        },
        suspected_claims: {
          type: 'array',
          items: { type: 'string', enum: ALL_CLAIM_TYPES },
        },
        notes: { type: 'array', items: { type: 'string' } },
        mark_complete: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'build_evidence_plan',
    description:
      'Seed or extend the evidence checklist from the curated CA + federal catalog based on the suspected claim types in the case profile. Does not touch Google Drive in this build.',
    inputSchema: {
      type: 'object',
      properties: {
        reseed: {
          type: 'boolean',
          default: false,
          description: 'If true, drop catalog-derived items that are still pending and regenerate from the current profile. Custom items and collected items are always preserved.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_checklist',
    description:
      'Add a custom item, edit an item, or change an item\'s status (have / collected / unavailable / skipped / pending).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'update', 'mark_have', 'mark_collected', 'mark_unavailable', 'skip', 'restore'],
        },
        id: { type: 'string', description: 'Checklist item id. Required for all actions except add.' },
        category: { type: 'string', enum: ALL_CATEGORIES, description: 'Required for add.' },
        description: { type: 'string', description: 'Required for add; optional for update.' },
        statute_hook: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'have', 'collected', 'unavailable', 'skipped'],
        },
        location_hint: {
          type: 'string',
          enum: ['work-laptop', 'personal-email', 'personal-phone', 'hr-portal', 'payroll-portal', 'paper', 'other'],
        },
        drive_file_id: { type: 'string' },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description:
      'Return the case profile, checklist summary grouped by category and status, a prioritized "next up" list, and URLs for the Drive folder and evidence memo when they exist.',
    inputSchema: {
      type: 'object',
      properties: {
        next_up_limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
      },
      additionalProperties: false,
    },
  },
] as const;
