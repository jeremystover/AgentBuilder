/** SHA-256 deduplication hash using the Web Crypto API (available in CF Workers). */
export async function computeDedupHash(
  accountId: string,
  postedDate: string,
  amount: number,
  description: string,
): Promise<string> {
  const input = `${accountId}|${postedDate}|${amount.toFixed(2)}|${description.toLowerCase().trim()}`;
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Strip noise from raw bank description strings for better dedup/matching. */
export function cleanDescription(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[^a-zA-Z0-9\s&'.#-]/g, '')
    .trim()
    .toLowerCase();
}

/** Parse a CSV line, respecting quoted fields. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function normalizeHeaderCell(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
}

function scoreHeaderRow(headers: string[]): number {
  const nonEmpty = headers.filter(Boolean).length;
  if (nonEmpty < 3) return nonEmpty;

  const joined = headers.join(' ');
  let score = nonEmpty;
  const strongSignals = [
    'date',
    'datetime',
    'description',
    'note',
    'amount',
    'transaction_date',
    'order_id',
    'from',
    'to',
  ];
  for (const signal of strongSignals) {
    if (joined.includes(signal)) score += 3;
  }
  return score;
}

/** Parse a whole CSV string into an array of objects keyed by header row. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  let headerIndex = 0;
  let bestScore = -1;
  const headerSearchLimit = Math.min(lines.length, 10);
  for (let i = 0; i < headerSearchLimit; i++) {
    const normalized = parseCsvLine(lines[i]).map(normalizeHeaderCell);
    const score = scoreHeaderRow(normalized);
    if (score > bestScore) {
      bestScore = score;
      headerIndex = i;
    }
  }

  const headers = parseCsvLine(lines[headerIndex]).map(normalizeHeaderCell);
  return lines.slice(headerIndex + 1).map(line => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}
