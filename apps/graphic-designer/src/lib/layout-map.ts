/**
 * Intent → layout selection.
 *
 * The default map below lists the preferred layoutObjectId for each intent
 * on the Gong template registered as the user default. All IDs are chosen
 * from the SAME master (g3cae6f62d46_1_*) — the Google Slides API rejects
 * createSlide batches that mix layouts across masters. When building against
 * a different template we fall back to per-template `best_fit_intents`
 * populated by `analyze_template`, then to a BLANK slide for "big-number",
 * then to the single-master bullets layout, then finally to the first
 * available layout.
 */

export type LayoutStrategy = 'explicit' | 'best-fit' | 'blank' | 'fallback';

export const BIG_NUMBER_INTENT = 'big-number';

// Default layout used when the intent is unrecognized and the template has
// analysis. Same master as everything else in DEFAULT_LAYOUT_MAP so the
// unknown-intent slide doesn't pull in a foreign master and break the batch.
export const FALLBACK_LAYOUT_ID = 'g3cae6f62d46_1_3607';

export const DEFAULT_LAYOUT_MAP: Record<string, string> = {
  // Core content
  'title-slide': 'g3cae6f62d46_1_3525',
  'section-break': 'g3cae6f62d46_1_3598',
  bullets: 'g3cae6f62d46_1_3607',
  'bullets-v2': 'g3cae6f62d46_1_3610',
  'bullets-v3': 'g3cae6f62d46_1_3613',
  closing: 'g3cae6f62d46_1_3575',

  // Centered titles
  'centered-title': 'g3cae6f62d46_1_3529',
  'centered-title-alt': 'g3cae6f62d46_1_3552',

  // Section breaks
  'section-break-v2': 'g3cae6f62d46_1_3601',
  'section-break-v3': 'g3cae6f62d46_1_3604',

  // Big numbers / hero stats
  'big-number': 'g3cae6f62d46_1_3532',
  'big-number-v2': 'g3cae6f62d46_1_3555',
  'big-number-v3': 'g3cae6f62d46_1_3578',

  // Multi-column content
  'four-columns': 'g3cae6f62d46_1_3782',
  'six-columns': 'g3cae6f62d46_1_3928',
  'ten-items': 'g3cae6f62d46_1_3936',
  'eight-items': 'g3cae6f62d46_1_3985',
  'two-column-text': 'g3cae6f62d46_1_4000',

  // Image layouts
  'image-left-text-right': 'g3cae6f62d46_1_3624',
  'image-right-text-left': 'g3cae6f62d46_1_3636',
  'image-hero-text': 'g3cae6f62d46_1_3621',
  'image-hero': 'g3cae6f62d46_1_3616',
  'image-with-caption': 'g3cae6f62d46_1_3981',
  'image-three-subtitles': 'g3cae6f62d46_1_3899',

  // Feature cards
  'three-features': 'g3cae6f62d46_1_3793',
  'three-features-v2': 'g3cae6f62d46_1_3801',
  'three-features-v3': 'g3cae6f62d46_1_3810',
  'four-features': 'g3cae6f62d46_1_3907',
  'four-features-v2': 'g3cae6f62d46_1_3918',
  'four-features-v3': 'g3cae6f62d46_1_3847',
  'five-features': 'g3cae6f62d46_1_3559',
  'five-features-v2': 'g3cae6f62d46_1_3582',
  'six-features': 'g3cae6f62d46_1_3960',

  // People cards
  'two-people': 'g3cae6f62d46_1_3768',
  'three-people': 'g3cae6f62d46_1_3748',
  'four-people': 'g3cae6f62d46_1_3722',
  'five-people': 'g3cae6f62d46_1_3536',
  'eight-people': 'g3cae6f62d46_1_3640',

  // Titles / quotes / blank
  'single-title': 'g3cae6f62d46_1_3892',
  'single-title-v2': 'g3cae6f62d46_1_3905',
  'two-titles': 'g3cae6f62d46_1_3950',
  quote: 'g3cae6f62d46_1_3555',
  blank: 'g3cae6f62d46_1_3618',
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

  // 3. Best-fit from analyze_template classification.
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

  // 4. big-number with no explicit layout or best-fit — render BLANK + centered text.
  if (intent === BIG_NUMBER_INTENT) {
    return {
      intent,
      layoutObjectId: null,
      strategy: 'blank',
      reason: 'big-number → BLANK predefined layout with centered textbox',
    };
  }

  // 5. Same-master bullets layout before falling back to the first layout —
  //    the template's first layout is often on a foreign master, which breaks
  //    the Slides API's single-master createSlide constraint.
  if (known.has(FALLBACK_LAYOUT_ID)) {
    return {
      intent,
      layoutObjectId: FALLBACK_LAYOUT_ID,
      strategy: 'fallback',
      reason: `no match for ${intent}; using single-master bullets layout ${FALLBACK_LAYOUT_ID}`,
    };
  }

  // 6. Last resort: first layout in the template.
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
