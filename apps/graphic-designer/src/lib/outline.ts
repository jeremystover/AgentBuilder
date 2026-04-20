/**
 * Outline parsing — accepts a slide outline as:
 *   • an array of { intent, title, subtitle, body, speakerNotes }
 *   • a JSON string of the above
 *   • a markdown document with "---" dividers (one slide per chunk)
 *
 * Markdown shape (all fields optional except title):
 *
 *   # Slide title  (intent: bullets)
 *   subtitle: Optional subtitle
 *
 *   - Body bullet one
 *   - Body bullet two
 *
 *   notes: Speaker notes, one paragraph.
 *
 *   ---
 *
 *   # Next slide  (intent: section-break)
 *   notes: ...
 *
 * If `intent:` is omitted on a slide, we infer it: first slide → title-slide,
 * slide with no body → section-break, otherwise bullets.
 */

import { AgentError } from '@agentbuilder/core';

export interface OutlineSlide {
  intent: string;
  title?: string;
  subtitle?: string;
  body?: string[];
  speakerNotes?: string;
}

export function parseOutline(input: unknown): OutlineSlide[] {
  if (Array.isArray(input)) {
    return input.map((s, i) => normalizeSlide(s, i, input.length));
  }
  if (typeof input !== 'string') {
    throw new AgentError('outline must be a JSON array, JSON string, or markdown string.', {
      code: 'invalid_input',
    });
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new AgentError('outline is empty.', { code: 'invalid_input' });
  }

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new AgentError(
        `outline starts with "[" but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { code: 'invalid_input' },
      );
    }
    if (!Array.isArray(parsed)) {
      throw new AgentError('outline JSON must be an array of slides.', { code: 'invalid_input' });
    }
    return parsed.map((s, i) => normalizeSlide(s, i, parsed.length));
  }

  return parseMarkdownOutline(trimmed);
}

function normalizeSlide(raw: unknown, index: number, total: number): OutlineSlide {
  if (!raw || typeof raw !== 'object') {
    throw new AgentError(`Slide ${index} is not an object.`, { code: 'invalid_input' });
  }
  const obj = raw as Record<string, unknown>;

  const intent = typeof obj.intent === 'string' && obj.intent.trim().length > 0
    ? obj.intent.trim()
    : inferIntent(obj, index, total);

  const body = normalizeBody(obj.body);

  const slide: OutlineSlide = { intent };
  if (typeof obj.title === 'string') slide.title = obj.title;
  if (typeof obj.subtitle === 'string') slide.subtitle = obj.subtitle;
  if (body) slide.body = body;
  if (typeof obj.speakerNotes === 'string') slide.speakerNotes = obj.speakerNotes;
  else if (typeof obj.notes === 'string') slide.speakerNotes = obj.notes;

  return slide;
}

function normalizeBody(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const items = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim());
    return items.length > 0 ? items : undefined;
  }
  if (typeof v === 'string') {
    const items = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function inferIntent(obj: Record<string, unknown>, index: number, total: number): string {
  if (index === 0) return 'title-slide';
  if (index === total - 1 && !obj.body) return 'closing';
  const body = normalizeBody(obj.body);
  if (!body || body.length === 0) return 'section-break';
  return 'bullets';
}

// ── Markdown parser ─────────────────────────────────────────────────────────

function parseMarkdownOutline(md: string): OutlineSlide[] {
  const chunks = md.split(/^-{3,}\s*$/m).map((c) => c.trim()).filter(Boolean);
  if (chunks.length === 0) {
    throw new AgentError('Markdown outline has no slide chunks.', { code: 'invalid_input' });
  }
  const slides = chunks.map((chunk, i) => parseMarkdownSlide(chunk, i, chunks.length));
  return slides;
}

function parseMarkdownSlide(chunk: string, index: number, total: number): OutlineSlide {
  const lines = chunk.split(/\r?\n/);
  let title: string | undefined;
  let subtitle: string | undefined;
  let intent: string | undefined;
  const body: string[] = [];
  const notesLines: string[] = [];
  let inNotes = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (inNotes) notesLines.push('');
      continue;
    }

    if (inNotes) {
      notesLines.push(rawLine);
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch && title === undefined) {
      const heading = headingMatch[1]!;
      const intentMatch = heading.match(/\(intent:\s*([a-z0-9-]+)\s*\)\s*$/i);
      if (intentMatch) {
        intent = intentMatch[1]!.toLowerCase();
        title = heading.slice(0, intentMatch.index).trim();
      } else {
        title = heading;
      }
      continue;
    }

    const subMatch = line.match(/^subtitle:\s*(.+)$/i);
    if (subMatch) {
      subtitle = subMatch[1]!.trim();
      continue;
    }

    const intentLineMatch = line.match(/^intent:\s*([a-z0-9-]+)\s*$/i);
    if (intentLineMatch) {
      intent = intentLineMatch[1]!.toLowerCase();
      continue;
    }

    const notesMatch = line.match(/^(?:notes|speaker notes|speakerNotes):\s*(.*)$/i);
    if (notesMatch) {
      const rest = notesMatch[1]!.trim();
      if (rest) notesLines.push(rest);
      inNotes = true;
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      body.push(bulletMatch[1]!.trim());
      continue;
    }

    // Plain prose line before "notes:" — treat as body paragraph.
    body.push(line);
  }

  const speakerNotes = notesLines.join('\n').trim() || undefined;
  const resolvedIntent = intent ?? inferIntent(
    { body: body.length > 0 ? body : undefined },
    index,
    total,
  );

  const slide: OutlineSlide = { intent: resolvedIntent };
  if (title) slide.title = title;
  if (subtitle) slide.subtitle = subtitle;
  if (body.length > 0) slide.body = body;
  if (speakerNotes) slide.speakerNotes = speakerNotes;
  return slide;
}
