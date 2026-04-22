/**
 * Tool manifests advertised via MCP `tools/list`.
 *
 * Only tools that are actually wired up are listed here. SKILL.md is the
 * roadmap; this file is runtime truth.
 */

import {
  ALL_CATEGORIES,
  ALL_CLAIM_TYPES,
  ALL_SIGNAL_FLAGS,
  ALL_SOURCE_TYPES,
} from '../lib/case-state.js';

export const MCP_TOOLS = [
  {
    name: 'intake_interview',
    description:
      'Record facts about the user\'s situation for a possible California employment dispute (age/disability/medical FEHA, failure-to-accommodate, failure-to-engage, retaliation, CFRA, Tameny, whistleblower, etc.). Merge any subset of fields; returns remaining intake questions and claim types the agent suggests adding based on the answers. Not legal advice.',
    inputSchema: {
      type: 'object',
      properties: {
        employer_name: { type: 'string' },
        employer_hq_state: { type: 'string' },
        employer_employee_count: { type: 'integer', minimum: 0 },
        employee_role: { type: 'string' },
        employee_age: { type: 'integer', minimum: 0, maximum: 120 },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        at_will: { type: 'boolean' },
        has_written_contract: { type: 'boolean' },
        has_arbitration_agreement: { type: 'boolean' },
        jurisdiction: { type: 'string', enum: ['CA', 'other', 'unknown'] },
        protected_classes: { type: 'array', items: { type: 'string' } },
        protected_activity: { type: 'array', items: { type: 'string' } },
        termination_narrative: { type: 'string' },
        suspected_claims: {
          type: 'array',
          items: { type: 'string', enum: ALL_CLAIM_TYPES },
        },
        notes: { type: 'array', items: { type: 'string' } },

        recent_praise_examples: {
          type: 'array',
          items: { type: 'string' },
          description: 'Quotes or paraphrases of recent praise, ideally with date and author.',
        },
        recent_bonus_percent: {
          type: 'number',
          description: 'Most recent bonus as % of target (e.g. 127).',
        },
        last_review_rating: { type: 'string' },
        had_pip_or_progressive_discipline: { type: 'boolean' },
        pip_narrative: { type: 'string' },
        asked_to_stay_and_transition: { type: 'boolean' },
        asked_to_stay_narrative: { type: 'string' },
        employer_knew_of_medical_before_decision: { type: 'boolean' },
        medical_knowledge_narrative: { type: 'string' },
        stated_reasons_timeline: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              reason: { type: 'string' },
              source: { type: 'string' },
            },
            required: ['reason'],
            additionalProperties: false,
          },
        },
        ageist_remarks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              place: { type: 'string' },
              remarker: { type: 'string' },
              exactWords: { type: 'string' },
              witnesses: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        equity_exercise_window: { type: 'string' },
        unvested_equity_value: { type: 'number' },

        mark_complete: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'build_evidence_plan',
    description:
      'Seed or extend the evidence checklist from the curated CA + federal catalog based on the suspected claim types. Catalog items carry default signal flags on collection where applicable. Does not touch Google Drive in this build.',
    inputSchema: {
      type: 'object',
      properties: {
        reseed: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_checklist',
    description:
      'Add a custom item, edit an item, or change status (have / collected / unavailable / skipped / pending / restore). On mark_collected or update, populate the evidence-index fields: file_name, source_type, dates, author, recipients, exact_quotes, why_it_matters, claim_tags, 1–5 scores, preserve_original, authenticity_notes, signal_flags.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'update', 'mark_have', 'mark_collected', 'mark_unavailable', 'skip', 'restore'],
        },
        id: { type: 'string' },
        category: { type: 'string', enum: ALL_CATEGORIES },
        description: { type: 'string' },
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

        file_name: { type: 'string' },
        source_type: { type: 'string', enum: ALL_SOURCE_TYPES },
        date_created: { type: 'string' },
        date_event: { type: 'string' },
        author: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            is_decisionmaker: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        recipients: { type: 'array', items: { type: 'string' } },
        exact_quotes: { type: 'array', items: { type: 'string' } },
        why_it_matters: { type: 'string' },
        claim_tags: {
          type: 'array',
          items: { type: 'string', enum: ALL_CLAIM_TYPES },
        },
        scores: {
          type: 'object',
          properties: {
            relevance: { type: 'integer', minimum: 1, maximum: 5 },
            reliability: { type: 'integer', minimum: 1, maximum: 5 },
            timing_proximity: { type: 'integer', minimum: 1, maximum: 5 },
            confidentiality_risk: { type: 'integer', minimum: 1, maximum: 5 },
          },
          additionalProperties: false,
        },
        preserve_original: { type: 'boolean' },
        authenticity_notes: { type: 'string' },
        signal_flags: {
          type: 'array',
          items: { type: 'string', enum: ALL_SIGNAL_FLAGS },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'status',
    description:
      'Return the case profile, checklist summary (by status / category / signal flag), prioritized "next up" (weighted by signal-flag presence), a top-scored list of already-collected items, and URLs for the Drive folder and evidence memo when they exist.',
    inputSchema: {
      type: 'object',
      properties: {
        next_up_limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
        top_scored_limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      additionalProperties: false,
    },
  },
] as const;
