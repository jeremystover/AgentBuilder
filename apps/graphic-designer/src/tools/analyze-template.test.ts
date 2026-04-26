import test from 'node:test';
import assert from 'node:assert/strict';

// Mock implementations for testing
interface MockLLMClient {
  complete: (opts: Record<string, unknown>) => Promise<{ text: string }>;
}

interface LayoutSummary {
  layoutObjectId: string;
  name: string;
  slotTypes: { type: string; shape: string; textCapacity: number }[];
  imageSlots: number;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function parseLlmArray(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1) {
    throw new Error('Classifier response did not contain a JSON array.');
  }

  const jsonSlice = trimmed.slice(firstBracket, lastBracket + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON array at position ${firstBracket}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Create synthetic layout summaries for testing
function createSyntheticLayouts(count: number): LayoutSummary[] {
  const layouts: LayoutSummary[] = [];
  for (let i = 0; i < count; i++) {
    layouts.push({
      layoutObjectId: `layout_${i}`,
      name: `Layout ${i}`,
      slotTypes: [
        { type: 'TITLE', shape: 'text_box', textCapacity: 100 },
        { type: 'BODY', shape: 'text_box', textCapacity: 500 },
      ],
      imageSlots: 1,
    });
  }
  return layouts;
}

// Generate valid LLM response for a batch of layouts
function generateLlmResponse(batchSize: number, offset: number = 0): string {
  const results = [];
  for (let i = 0; i < batchSize; i++) {
    const idx = offset + i;
    results.push({
      displayName: `Layout ${idx} - Title and Body`,
      bestFitIntents: ['single-idea', 'bullets'],
      textCapacity: 600,
    });
  }
  return JSON.stringify(results);
}

test('chunkArray splits layouts correctly', () => {
  const items = Array.from({ length: 81 }, (_, i) => i);
  const chunks = chunkArray(items, 15);

  assert.equal(chunks.length, 6); // 81 / 15 = 5.4, rounds up to 6
  assert.equal(chunks[0]?.length, 15);
  assert.equal(chunks[1]?.length, 15);
  assert.equal(chunks[2]?.length, 15);
  assert.equal(chunks[3]?.length, 15);
  assert.equal(chunks[4]?.length, 15);
  assert.equal(chunks[5]?.length, 6); // Last chunk has remainder
});

test('chunkArray handles exact multiples', () => {
  const items = Array.from({ length: 60 }, (_, i) => i);
  const chunks = chunkArray(items, 15);

  assert.equal(chunks.length, 4);
  chunks.forEach((chunk) => {
    assert.equal(chunk?.length, 15);
  });
});

test('chunkArray handles single batch', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const chunks = chunkArray(items, 15);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.length, 10);
});

test('parseLlmArray extracts JSON from plain text', () => {
  const json = '[{"name":"Layout 0"},{"name":"Layout 1"}]';
  const result = parseLlmArray(json);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
});

test('parseLlmArray strips markdown code blocks', () => {
  const json = '```json\n[{"name":"Layout 0"},{"name":"Layout 1"}]\n```';
  const result = parseLlmArray(json);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
});

test('parseLlmArray throws on invalid JSON', () => {
  const json = '[{"name":"Layout 0"}, invalid}]';
  assert.throws(() => parseLlmArray(json), /Failed to parse JSON/);
});

test('parseLlmArray throws on missing array brackets', () => {
  const json = '{"name":"Layout 0"}';
  assert.throws(() => parseLlmArray(json), /did not contain a JSON array/);
});

test('synthetic 81-layout deck chunks correctly', () => {
  const layouts = createSyntheticLayouts(81);
  assert.equal(layouts.length, 81);

  const chunks = chunkArray(layouts, 15);
  assert.equal(chunks.length, 6);

  // Verify all layouts are present
  let totalLayouts = 0;
  chunks.forEach((chunk) => {
    totalLayouts += chunk.length;
  });
  assert.equal(totalLayouts, 81);
});

test('synthetic 50-layout deck chunks correctly', () => {
  const layouts = createSyntheticLayouts(50);
  assert.equal(layouts.length, 50);

  const chunks = chunkArray(layouts, 15);
  assert.equal(chunks.length, 4); // 50 / 15 = 3.33, rounds up to 4

  assert.equal(chunks[0]?.length, 15);
  assert.equal(chunks[1]?.length, 15);
  assert.equal(chunks[2]?.length, 15);
  assert.equal(chunks[3]?.length, 5);
});

test('LLM response generation creates correct batch sizes', () => {
  const response1 = generateLlmResponse(15, 0);
  const result1 = parseLlmArray(response1);
  assert.ok(Array.isArray(result1));
  assert.equal(result1.length, 15);

  const response2 = generateLlmResponse(6, 75);
  const result2 = parseLlmArray(response2);
  assert.ok(Array.isArray(result2));
  assert.equal(result2.length, 6);
});

test('batch classification preserves layout count', () => {
  const layouts = createSyntheticLayouts(81);
  const chunks = chunkArray(layouts, 15);

  // Simulate processing each chunk
  const allResults: unknown[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i];
    if (!batch) continue;
    const llmResponse = generateLlmResponse(batch.length, i * 15);
    const batchResults = parseLlmArray(llmResponse);
    assert.ok(Array.isArray(batchResults));
    allResults.push(...(batchResults as unknown[]));
  }

  assert.equal(allResults.length, 81);
});

test('handles edge case: exactly 1 layout', () => {
  const layouts = createSyntheticLayouts(1);
  const chunks = chunkArray(layouts, 15);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.length, 1);
});

test('handles edge case: exactly batch size', () => {
  const layouts = createSyntheticLayouts(15);
  const chunks = chunkArray(layouts, 15);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.length, 15);
});

test('handles edge case: one more than batch size', () => {
  const layouts = createSyntheticLayouts(16);
  const chunks = chunkArray(layouts, 15);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, 15);
  assert.equal(chunks[1]?.length, 1);
});
