import type {
  CaseState,
  ChecklistCategory,
  ChecklistItem,
  ClaimType,
  SignalFlag,
} from '../../lib/case-state.js';

export interface GenerateTopPacketInput {
  /** How many items to surface. Default 20, clamped 1..100. */
  top_n?: number;
  /** If true (default), only include collected/have items. If false, also include pending items that carry signal flags or scores. */
  require_collected?: boolean;
  /** Restrict to items tagged with any of these claim types. */
  claim_filter?: ClaimType[];
}

export interface TopPacketItem {
  rank: number;
  composite_score: number;
  id: string;
  category: ChecklistCategory;
  description: string;
  date_event?: string;
  date_created?: string;
  source_type?: string;
  author?: ChecklistItem['author'];
  recipients?: string[];
  exact_quotes?: string[];
  why_it_matters?: string;
  claim_tags?: ClaimType[];
  signal_flags?: SignalFlag[];
  scores?: ChecklistItem['scores'];
  preserve_original?: boolean;
  location_hint?: string;
  drive_file_id?: string;
  file_name?: string;
}

export interface GenerateTopPacketOutput {
  packet: TopPacketItem[];
  summary: {
    total_considered: number;
    total_included: number;
    by_category: Record<string, number>;
    by_signal_flag: Record<string, number>;
    by_claim: Record<string, number>;
  };
  notes_to_user: string[];
}

/**
 * Rank documents for the guidance's "Top-20 packet" — the most persuasive
 * exhibits for negotiation or lawyer review. Scoring is deliberately
 * transparent so the user's attorney can see why each item surfaced.
 */
export function generateTopPacket(
  state: CaseState,
  input: GenerateTopPacketInput,
): GenerateTopPacketOutput {
  const topN = clamp(input.top_n ?? 20, 1, 100);
  const requireCollected = input.require_collected ?? true;
  const claimFilter = input.claim_filter?.length ? new Set(input.claim_filter) : null;

  const considered = state.checklist.filter((i) => {
    if (requireCollected) {
      if (i.status !== 'collected' && i.status !== 'have') return false;
    } else {
      if (i.status === 'skipped' || i.status === 'unavailable') return false;
    }
    if (claimFilter) {
      if (!i.claimTags?.some((c) => claimFilter.has(c))) return false;
    }
    return true;
  });

  const scored = considered
    .map((item) => ({ item, score: topPacketScore(item) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break: most recent event first.
      const ae = a.item.dateEvent ?? '';
      const be = b.item.dateEvent ?? '';
      return be.localeCompare(ae);
    });

  const packet: TopPacketItem[] = scored.slice(0, topN).map((x, idx) => ({
    rank: idx + 1,
    composite_score: round(x.score),
    id: x.item.id,
    category: x.item.category,
    description: x.item.description,
    date_event: x.item.dateEvent,
    date_created: x.item.dateCreated,
    source_type: x.item.sourceType,
    author: x.item.author,
    recipients: x.item.recipients,
    exact_quotes: x.item.exactQuotes,
    why_it_matters: x.item.whyItMatters,
    claim_tags: x.item.claimTags,
    signal_flags: x.item.signalFlags,
    scores: x.item.scores,
    preserve_original: x.item.preserveOriginal,
    location_hint: x.item.locationHint,
    drive_file_id: x.item.driveFileId,
    file_name: x.item.fileName,
  }));

  const byCategory: Record<string, number> = {};
  const bySignalFlag: Record<string, number> = {};
  const byClaim: Record<string, number> = {};
  for (const p of packet) {
    byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    for (const f of p.signal_flags ?? []) bySignalFlag[f] = (bySignalFlag[f] ?? 0) + 1;
    for (const c of p.claim_tags ?? []) byClaim[c] = (byClaim[c] ?? 0) + 1;
  }

  const notes: string[] = [];
  if (packet.length === 0) {
    notes.push(
      requireCollected
        ? 'No collected items yet. Run update_checklist(mark_collected) with full metadata on your best exhibits, then rerun.'
        : 'No scorable items yet. Add scores/signal flags via update_checklist for the items you have.',
    );
  } else if (packet.length < topN) {
    notes.push(
      `Only ${packet.length} scorable items available — add more metadata (scores, signal flags, exact_quotes) to additional collected items to grow the packet.`,
    );
  }

  return {
    packet,
    summary: {
      total_considered: considered.length,
      total_included: packet.length,
      by_category: byCategory,
      by_signal_flag: bySignalFlag,
      by_claim: byClaim,
    },
    notes_to_user: notes,
  };
}

/**
 * Composite score:
 *   relevance * 3   +   reliability * 2   +   timing_proximity * 2
 *   - confidentiality_risk * 1
 *   + 2 per signal flag (the legally-important patterns)
 *   + 2 if author is a decisionmaker
 *   + 1 if the original is preserved
 *   + 1 if exact quotes were captured
 *
 * Transparent so counsel can re-rank by their own weights if desired.
 */
export function topPacketScore(item: ChecklistItem): number {
  const s = item.scores ?? {};
  let score =
    (s.relevance ?? 0) * 3 +
    (s.reliability ?? 0) * 2 +
    (s.timingProximity ?? 0) * 2 -
    (s.confidentialityRisk ?? 0);
  score += (item.signalFlags?.length ?? 0) * 2;
  if (item.author?.isDecisionmaker) score += 2;
  if (item.preserveOriginal) score += 1;
  if ((item.exactQuotes?.length ?? 0) > 0) score += 1;
  return score;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
