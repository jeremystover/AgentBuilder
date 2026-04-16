import type { VectorizeIndex } from "@cloudflare/workers-types";

export interface VectorRecord {
  id:       string;
  values:   number[];
  metadata: Record<string, string>;
}

export interface VectorMatch {
  id:       string;
  score:    number;
  metadata: Record<string, string> | null;
}

export async function upsertVector(
  index: VectorizeIndex,
  record: VectorRecord,
): Promise<void> {
  await index.upsert([{ id: record.id, values: record.values, metadata: record.metadata }]);
}

export async function upsertVectorBatch(
  index: VectorizeIndex,
  records: VectorRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const BATCH = 1000;
  for (let i = 0; i < records.length; i += BATCH) {
    await index.upsert(
      records.slice(i, i + BATCH).map((r) => ({
        id: r.id, values: r.values, metadata: r.metadata,
      })),
    );
  }
}

export async function queryVectors(
  index: VectorizeIndex,
  vector: number[],
  opts: { topK?: number; filter?: Record<string, string>; returnMetadata?: boolean } = {},
): Promise<VectorMatch[]> {
  const result = await index.query(vector, {
    topK:           opts.topK ?? 10,
    // Conditionally include filter — exactOptionalPropertyTypes disallows passing undefined
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
    returnMetadata: opts.returnMetadata !== false ? "all" : "none",
    returnValues:   false,
  });

  return (result.matches ?? []).map((m) => ({
    id:       m.id,
    score:    m.score,
    metadata: (m.metadata as Record<string, string>) ?? null,
  }));
}

export async function deleteVector(index: VectorizeIndex, id: string): Promise<void> {
  await index.deleteByIds([id]);
}
