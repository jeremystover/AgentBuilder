/**
 * Intent → layout selection.
 *
 * The default map below lists the preferred layoutObjectId for each intent
 * on the Gong template registered as the user default. When building against
 * a different template we fall back to per-template `best_fit_intents`
 * populated by `analyze_template`, then to a BLANK slide for "big-number",
 * then finally to the first available layout.
 */

export type LayoutStrategy = 'explicit' | 'best-fit' | 'blank' | 'fallback';

export const BIG_NUMBER_INTENT = 'big-number';

export const DEFAULT_LAYOUT_MAP: Record<string, string> = {
  'title-slide': 'g3cae6f62d46_1_3525',
  'section-break': 'p26',
  bullets: 'g2903e80e4ad_0_76',
  'two-columns': 'g82b45e6254_1_233',
  'three-ideas': 'g7c9a7880b0_0_473',
  closing: 'g3cae6f62d46_1_3575',
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

  // 2. Default intent map, if the ID is present in the template.
  const mapped = DEFAULT_LAYOUT_MAP[intent];
  if (mapped && known.has(mapped)) {
    return {
      intent,
      layoutObjectId: mapped,
      strategy: 'explicit',
      reason: `default map ${intent} → ${mapped}`,
    };
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
