import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LAYOUT_MAP,
  selectLayoutForIntent,
  type TemplateLayout,
} from '../lib/layout-map.js';
import { parseOutline } from '../lib/outline.js';

// ── layout-map ──────────────────────────────────────────────────────────────

const GONG_LAYOUTS: TemplateLayout[] = [
  { layoutObjectId: 'g3cae6f62d46_1_3525', name: 'TITLE', displayName: 'Title with image' },
  { layoutObjectId: 'p26', name: 'SECTION', displayName: 'Navy divider' },
  { layoutObjectId: 'g2903e80e4ad_0_76', name: 'TITLE_AND_BODY', displayName: 'Title + body' },
  { layoutObjectId: 'g82b45e6254_1_233', name: 'TWO_COLUMNS', displayName: 'Two-column body' },
  { layoutObjectId: 'g7c9a7880b0_0_473', name: 'THREE_COLUMN', displayName: 'Title + 3 columns' },
  { layoutObjectId: 'g3cae6f62d46_1_3575', name: 'CLOSING', displayName: 'Title + subtitle' },
  { layoutObjectId: 'other', name: 'OTHER', bestFitIntents: ['quote', 'image-hero'] },
];

test('selectLayoutForIntent resolves every mapped intent via default map', () => {
  for (const [intent, layoutId] of Object.entries(DEFAULT_LAYOUT_MAP)) {
    const pick = selectLayoutForIntent(intent, GONG_LAYOUTS);
    assert.equal(pick.strategy, 'explicit', `intent=${intent}`);
    assert.equal(pick.layoutObjectId, layoutId);
  }
});

test('selectLayoutForIntent returns BLANK for big-number', () => {
  const pick = selectLayoutForIntent('big-number', GONG_LAYOUTS);
  assert.equal(pick.strategy, 'blank');
  assert.equal(pick.layoutObjectId, null);
});

test('selectLayoutForIntent honors per-call override when present', () => {
  const pick = selectLayoutForIntent('bullets', GONG_LAYOUTS, { bullets: 'other' });
  assert.equal(pick.strategy, 'explicit');
  assert.equal(pick.layoutObjectId, 'other');
});

test('selectLayoutForIntent falls back to best-fit when default ID missing', () => {
  const layouts: TemplateLayout[] = [
    { layoutObjectId: 'quote-layout', bestFitIntents: ['quote'] },
    { layoutObjectId: 'generic', bestFitIntents: ['bullets', 'single-idea'] },
  ];
  const pick = selectLayoutForIntent('bullets', layouts);
  assert.equal(pick.strategy, 'best-fit');
  assert.equal(pick.layoutObjectId, 'generic');
});

test('selectLayoutForIntent falls back to first layout when no match at all', () => {
  const layouts: TemplateLayout[] = [
    { layoutObjectId: 'first', bestFitIntents: [] },
    { layoutObjectId: 'second', bestFitIntents: [] },
  ];
  const pick = selectLayoutForIntent('some-unknown-intent', layouts);
  assert.equal(pick.strategy, 'fallback');
  assert.equal(pick.layoutObjectId, 'first');
});

test('selectLayoutForIntent on empty template collapses to blank', () => {
  const pick = selectLayoutForIntent('bullets', []);
  assert.equal(pick.strategy, 'blank');
  assert.equal(pick.layoutObjectId, null);
});

// ── outline parser ──────────────────────────────────────────────────────────

test('parseOutline accepts a JSON array directly', () => {
  const outline = [
    { intent: 'title-slide', title: 'Deck', subtitle: 'Sub' },
    { intent: 'bullets', title: 'Points', body: ['one', 'two'] },
  ];
  const parsed = parseOutline(outline);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.intent, 'title-slide');
  assert.deepEqual(parsed[1]?.body, ['one', 'two']);
});

test('parseOutline accepts a JSON string', () => {
  const json = JSON.stringify([
    {
      intent: 'section-break',
      title: 'Part One',
      speakerNotes: 'kick it off',
    },
  ]);
  const parsed = parseOutline(json);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.intent, 'section-break');
  assert.equal(parsed[0]?.speakerNotes, 'kick it off');
});

test('parseOutline accepts `notes` as an alias for speakerNotes', () => {
  const parsed = parseOutline([{ intent: 'bullets', title: 'X', notes: 'hello' }]);
  assert.equal(parsed[0]?.speakerNotes, 'hello');
});

test('parseOutline infers intent when omitted', () => {
  const parsed = parseOutline([
    { title: 'Opener' },
    { title: 'Section A' },
    { title: 'Details', body: ['one'] },
  ]);
  assert.equal(parsed[0]?.intent, 'title-slide');
  assert.equal(parsed[1]?.intent, 'section-break');
  assert.equal(parsed[2]?.intent, 'bullets');
});

test('parseOutline accepts markdown with --- dividers and intent annotations', () => {
  const md = `# Hello World (intent: title-slide)
subtitle: A subtitle

notes: opening remarks

---

# AI Coaching (intent: section-break)

---

# Tools (intent: bullets)
- CoachHub
- BetterUp
- Torch

notes: call out pricing
`;
  const parsed = parseOutline(md);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.intent, 'title-slide');
  assert.equal(parsed[0]?.title, 'Hello World');
  assert.equal(parsed[0]?.subtitle, 'A subtitle');
  assert.equal(parsed[0]?.speakerNotes, 'opening remarks');
  assert.equal(parsed[1]?.intent, 'section-break');
  assert.equal(parsed[2]?.intent, 'bullets');
  assert.deepEqual(parsed[2]?.body, ['CoachHub', 'BetterUp', 'Torch']);
  assert.equal(parsed[2]?.speakerNotes, 'call out pricing');
});

test('parseOutline rejects empty input', () => {
  assert.throws(() => parseOutline(''), /empty/);
});

test('parseOutline rejects non-array JSON', () => {
  assert.throws(() => parseOutline('[not json'), /not valid JSON/);
});

test('parseOutline rejects non-string/array input', () => {
  assert.throws(() => parseOutline(42), /JSON array, JSON string, or markdown/);
});

test('parseOutline normalizes body given as string', () => {
  const parsed = parseOutline([{ intent: 'bullets', title: 'X', body: 'one\ntwo\n' }]);
  assert.deepEqual(parsed[0]?.body, ['one', 'two']);
});
