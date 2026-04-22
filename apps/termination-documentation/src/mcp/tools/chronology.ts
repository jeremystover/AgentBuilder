import {
  ALL_CLAIM_TYPES,
  ALL_SIGNAL_FLAGS,
  type CaseState,
  type ChronologyEvent,
  type ClaimType,
  type SignalFlag,
  makeChronologyId,
} from '../../lib/case-state.js';

export type ChronologyAction = 'add' | 'list' | 'update' | 'delete';

export interface ChronologyInput {
  action: ChronologyAction;
  id?: string;

  // add / update fields
  date?: string;
  actors?: string[];
  event?: string;
  exact_quote?: string;
  supporting_item_ids?: string[];
  why_it_matters?: string;
  claim_tags?: string[];
  signal_flags?: string[];

  // list filters
  since?: string;
  until?: string;
  claim_filter?: string[];
  signal_flag_filter?: string[];
  limit?: number;
}

export interface ChronologyOutput {
  action: ChronologyAction;
  event?: ChronologyEvent;
  events?: ChronologyEvent[];
  total: number;
  earliest_date?: string;
  latest_date?: string;
  notes_to_user: string[];
}

const CLAIM_SET = new Set<ClaimType>(ALL_CLAIM_TYPES);
const SIGNAL_SET = new Set<SignalFlag>(ALL_SIGNAL_FLAGS);

function coerceClaims(input: string[] | undefined): ClaimType[] | undefined {
  if (!input) return undefined;
  const out = input.filter((c) => CLAIM_SET.has(c as ClaimType)) as ClaimType[];
  return out.length ? Array.from(new Set(out)) : undefined;
}

function coerceFlags(input: string[] | undefined): SignalFlag[] | undefined {
  if (!input) return undefined;
  const out = input.filter((f) => SIGNAL_SET.has(f as SignalFlag)) as SignalFlag[];
  return out.length ? Array.from(new Set(out)) : undefined;
}

export function chronology(
  state: CaseState,
  input: ChronologyInput,
): { state: CaseState; output: ChronologyOutput } {
  const chronology = [...state.chronology];
  const notes: string[] = [];

  switch (input.action) {
    case 'add': {
      if (!input.date) throw new Error('add requires a date');
      if (!input.event || input.event.trim().length === 0)
        throw new Error('add requires an event description');
      const knownItemIds = new Set(state.checklist.map((i) => i.id));
      const supportingItemIds = (input.supporting_item_ids ?? []).filter((id) => {
        if (knownItemIds.has(id)) return true;
        notes.push(`Dropped unknown supporting item id: ${id}`);
        return false;
      });
      const ev: ChronologyEvent = {
        id: makeChronologyId(),
        date: input.date,
        actors: input.actors ?? [],
        event: input.event.trim(),
        exactQuote: input.exact_quote,
        supportingItemIds,
        whyItMatters: input.why_it_matters,
        claimTags: coerceClaims(input.claim_tags),
        signalFlags: coerceFlags(input.signal_flags),
      };
      chronology.push(ev);
      return {
        state: { ...state, chronology },
        output: {
          action: 'add',
          event: ev,
          total: chronology.length,
          notes_to_user: notes,
          ...spanStats(chronology),
        },
      };
    }

    case 'update': {
      if (!input.id) throw new Error('update requires id');
      const idx = chronology.findIndex((e) => e.id === input.id);
      if (idx < 0) throw new Error(`No chronology event with id=${input.id}`);
      const current = chronology[idx]!;
      const merged: ChronologyEvent = { ...current };
      if (input.date !== undefined) merged.date = input.date;
      if (input.actors !== undefined) merged.actors = [...input.actors];
      if (input.event !== undefined) merged.event = input.event;
      if (input.exact_quote !== undefined) merged.exactQuote = input.exact_quote;
      if (input.supporting_item_ids !== undefined) {
        const knownItemIds = new Set(state.checklist.map((i) => i.id));
        merged.supportingItemIds = input.supporting_item_ids.filter((id) => {
          if (knownItemIds.has(id)) return true;
          notes.push(`Dropped unknown supporting item id: ${id}`);
          return false;
        });
      }
      if (input.why_it_matters !== undefined) merged.whyItMatters = input.why_it_matters;
      if (input.claim_tags !== undefined) merged.claimTags = coerceClaims(input.claim_tags);
      if (input.signal_flags !== undefined) merged.signalFlags = coerceFlags(input.signal_flags);
      chronology[idx] = merged;
      return {
        state: { ...state, chronology },
        output: {
          action: 'update',
          event: merged,
          total: chronology.length,
          notes_to_user: notes,
          ...spanStats(chronology),
        },
      };
    }

    case 'delete': {
      if (!input.id) throw new Error('delete requires id');
      const idx = chronology.findIndex((e) => e.id === input.id);
      if (idx < 0) throw new Error(`No chronology event with id=${input.id}`);
      chronology.splice(idx, 1);
      return {
        state: { ...state, chronology },
        output: {
          action: 'delete',
          total: chronology.length,
          notes_to_user: [`Deleted event ${input.id}`],
          ...spanStats(chronology),
        },
      };
    }

    case 'list': {
      const claimFilter = coerceClaims(input.claim_filter);
      const flagFilter = coerceFlags(input.signal_flag_filter);
      let filtered = [...state.chronology];
      if (input.since) filtered = filtered.filter((e) => e.date >= input.since!);
      if (input.until) filtered = filtered.filter((e) => e.date <= input.until!);
      if (claimFilter)
        filtered = filtered.filter((e) =>
          (e.claimTags ?? []).some((c) => claimFilter.includes(c)),
        );
      if (flagFilter)
        filtered = filtered.filter((e) =>
          (e.signalFlags ?? []).some((f) => flagFilter.includes(f)),
        );
      filtered.sort((a, b) => a.date.localeCompare(b.date));
      const limit = input.limit ? Math.max(1, Math.min(500, input.limit)) : filtered.length;
      return {
        state,
        output: {
          action: 'list',
          events: filtered.slice(0, limit),
          total: filtered.length,
          notes_to_user: notes,
          ...spanStats(filtered),
        },
      };
    }

    default:
      throw new Error(`Unknown chronology action: ${input.action}`);
  }
}

function spanStats(events: ChronologyEvent[]): { earliest_date?: string; latest_date?: string } {
  if (events.length === 0) return {};
  let earliest = events[0]!.date;
  let latest = events[0]!.date;
  for (const e of events) {
    if (e.date < earliest) earliest = e.date;
    if (e.date > latest) latest = e.date;
  }
  return { earliest_date: earliest, latest_date: latest };
}
