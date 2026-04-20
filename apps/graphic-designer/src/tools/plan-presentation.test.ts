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

test('selectLayoutForIntent trusts default map when template has no analysis', () => {
  // Without analysis, mapped intents should still return the default layoutObjectId
  // so build_presentation doesn't fall back to BLANK slides on the Gong template.
  const pick = selectLayoutForIntent('bullets', []);
  assert.equal(pick.strategy, 'explicit');
  assert.equal(pick.layoutObjectId, DEFAULT_LAYOUT_MAP.bullets);
  assert.match(pick.reason, /unverified/);
});

test('selectLayoutForIntent on empty template collapses unknown intents to blank', () => {
  const pick = selectLayoutForIntent('some-exotic-intent', []);
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

test('parseOutline splits numbered-list outlines into individual slides', () => {
  const outline = `1. Title Slide
Title: "AI in Talent Development: What Teams Are Using Now"
Subtitle: "A Landscape Guide for L&D Leaders"
Speaker Notes: Welcome everyone to this overview of AI in L&D.

2. Chapter Divider
Title: AI Coaching & Mentoring
Speaker Notes: In this first section we'll look at conversational coaching tools.

3. Content Slide
Title: AI Coaching & Mentoring
Subtitle: Category 1 of 6
Body:
  - CoachHub, BetterUp, Torch
  - 24/7 conversational AI coaching
  - Scales beyond executive level
Speaker Notes: Call out pricing and adoption benchmarks.

4. Closing
Title: Thank You
Speaker Notes: Wrap up with Q&A invitation.
`;

  const parsed = parseOutline(outline);
  assert.equal(parsed.length, 4);

  assert.equal(parsed[0]?.intent, 'title-slide');
  assert.equal(parsed[0]?.title, 'AI in Talent Development: What Teams Are Using Now');
  assert.equal(parsed[0]?.subtitle, 'A Landscape Guide for L&D Leaders');
  assert.match(parsed[0]?.speakerNotes ?? '', /Welcome everyone/);

  assert.equal(parsed[1]?.intent, 'section-break');
  assert.equal(parsed[1]?.title, 'AI Coaching & Mentoring');

  assert.equal(parsed[2]?.intent, 'bullets');
  assert.equal(parsed[2]?.subtitle, 'Category 1 of 6');
  assert.deepEqual(parsed[2]?.body, [
    'CoachHub, BetterUp, Torch',
    '24/7 conversational AI coaching',
    'Scales beyond executive level',
  ]);

  assert.equal(parsed[3]?.intent, 'closing');
  assert.equal(parsed[3]?.title, 'Thank You');
});

test('parseOutline numbered-list: intent-from-label handles common aliases', () => {
  const outline = `1. Title Slide
Title: Opener

2. Section Divider
Title: Part One

3. Two-Column Content
Title: Comparison

4. Three-Up Idea
Title: Trio

5. Big-Number Highlight
Body:
  - 87%

6. Closing Slide
Title: Fin
`;
  const parsed = parseOutline(outline);
  assert.equal(parsed.length, 6);
  assert.equal(parsed[0]?.intent, 'title-slide');
  assert.equal(parsed[1]?.intent, 'section-break');
  assert.equal(parsed[2]?.intent, 'two-columns');
  assert.equal(parsed[3]?.intent, 'three-ideas');
  assert.equal(parsed[4]?.intent, 'big-number');
  assert.equal(parsed[5]?.intent, 'closing');
});

test('parseOutline numbered-list: explicit intent: tag overrides label inference', () => {
  const outline = `1. Random header
Title: Foo
Intent: two-columns

2. Another header
Title: Bar
Intent: closing
`;
  const parsed = parseOutline(outline);
  assert.equal(parsed[0]?.intent, 'two-columns');
  assert.equal(parsed[1]?.intent, 'closing');
});

test('parseOutline numbered-list: single item is NOT split (falls back to markdown)', () => {
  // Only one numbered item — should fall back to markdown parser.
  const outline = `1. Title Slide
Title: Solo
`;
  const parsed = parseOutline(outline);
  // Markdown parser sees no `#` heading or `---` and treats everything as body
  // of a single slide. That's fine — the point is we didn't pretend a single-
  // item numbered list was a multi-slide outline.
  assert.equal(parsed.length, 1);
});
