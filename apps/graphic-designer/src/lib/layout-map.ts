/**
 * Intent → layout selection.
 *
 * The default map below lists the preferred layoutObjectId for each intent
 * on the Gong template registered as the user default. All IDs are chosen
 * from the SAME master (g3cae6f62d46_1_*) — the Google Slides API rejects
 * createSlide batches that mix layouts across masters. When building against
 * a different template we fall back to per-template `best_fit_intents`
 * populated by `analyze_template`, then to a BLANK slide for "big-number",
 * then finally to the first available layout.
 */

export type LayoutStrategy = 'explicit' | 'best-fit' | 'blank' | 'fallback';

export const BIG_NUMBER_INTENT = 'big-number';

export const DEFAULT_LAYOUT_MAP: Record<string, string> = {
  'title-slide': 'g3cae6f62d46_1_3525',
  'section-break': 'g3cae6f62d46_1_3598',
  bullets: 'g3cae6f62d46_1_3607',
  'two-columns': 'g3cae6f62d46_1_3610',
  closing: 'g3cae6f62d46_1_3575',
  // three-ideas intentionally omitted — no single-master equivalent on this
  // template. Falls back to best-fit (if analyzed) or BLANK.
  // big-number intentionally omitted — handled as a BLANK slide with a centered textbox.
};

export interface TemplateLayout {
  layoutObjectId: string;
  name?: string;
  displayName?: string;
  bestFitIntents?: string[];
}

export interface LayoutSelection {
  intent: string;
  layoutObjectId: string | null;
  strategy: LayoutStrategy;
  reason: string;
}

export function selectLayoutForIntent(
  intent: string,
  templateLayouts: TemplateLayout[],
  overrides: Record<string, string> = {},
): LayoutSelection {
  const known = new Set(templateLayouts.map((l) => l.layoutObjectId));

  // 1. Explicit override (per-call) wins.
  const override = overrides[intent];
  if (override && known.has(override)) {
    return {
      intent,
      layoutObjectId: override,
      strategy: 'explicit',
      reason: `override map ${intent} → ${override}`,
    };
  }

  // 2. Default intent map.
  //    If we have analysis, require the mapped ID to be present in the template
  //    (a mismatch means this isn't the Gong template and we should fall through
  //    to best-fit). If we have no analysis at all, trust the default map —
  //    running `analyze_template` is recommended but not required.
  const mapped = DEFAULT_LAYOUT_MAP[intent];
  if (mapped) {
    if (templateLayouts.length === 0) {
      return {
        intent,
        layoutObjectId: mapped,
        strategy: 'explicit',
        reason: `default map ${intent} → ${mapped} (unverified — template not analyzed)`,
      };
    }
    if (known.has(mapped)) {
      return {
        intent,
        layoutObjectId: mapped,
        strategy: 'explicit',
        reason: `default map ${intent} → ${mapped}`,
      };
    }
  }

  // 3. big-number has no explicit layout — always render BLANK + centered text.
  if (intent === BIG_NUMBER_INTENT) {
    return {
      intent,
      layoutObjectId: null,
      strategy: 'blank',
      reason: 'big-number → BLANK predefined layout with centered textbox',
    };
  }

  // 4. Best-fit from analyze_template classification.
  const bestFit = templateLayouts.find((l) =>
    Array.isArray(l.bestFitIntents) && l.bestFitIntents.includes(intent),
  );
  if (bestFit) {
    return {
      intent,
      layoutObjectId: bestFit.layoutObjectId,
      strategy: 'best-fit',
      reason: `analyze_template classified ${bestFit.layoutObjectId} (${bestFit.displayName ?? bestFit.name ?? '?'}) as best-fit for ${intent}`,
    };
  }

  // 5. Last resort: first layout in the template.
  const first = templateLayouts[0];
  if (first) {
    return {
      intent,
      layoutObjectId: first.layoutObjectId,
      strategy: 'fallback',
      reason: `no match for ${intent}; using first layout ${first.layoutObjectId}`,
    };
  }

  return {
    intent,
    layoutObjectId: null,
    strategy: 'blank',
    reason: `no layouts available; using BLANK predefined layout`,
  };
}
