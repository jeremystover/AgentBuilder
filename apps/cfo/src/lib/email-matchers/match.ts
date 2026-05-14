// Amount sign convention: Teller posts credit-card spend as positive,
// bank-account debits as negative. Matchers compare on |amount| so the
// per-vendor weights below don't need to think about sign.

export type VendorHint = 'amazon' | 'venmo' | 'apple' | 'etsy';
export type MatchType = 'exact' | 'probable' | 'possible' | null;

export interface MatchCandidate {
  transaction_id: string;
  date: string;
  amount: number;
  description: string;
}

export interface MatchResult {
  transaction_id: string;
  score: number;
  match_type: MatchType;
}

function distanceInDays(a: string, b: string): number {
  const aMs = new Date(`${a}T00:00:00.000Z`).getTime();
  const bMs = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.round(Math.abs(aMs - bMs) / 86400000);
}

export interface ParsedForMatch {
  amount: number;
  date: string;
}

export function scoreMatch(
  candidate: MatchCandidate,
  parsed: ParsedForMatch,
  vendorHint: VendorHint,
): number {
  const desc = candidate.description.toLowerCase();
  const distance = distanceInDays(candidate.date, parsed.date);
  const exactAmount = Math.abs(Math.abs(candidate.amount) - Math.abs(parsed.amount)) < 0.01;

  switch (vendorHint) {
    case 'amazon': {
      // Base 50. Date within ±4 days forward: +25 scaled by closeness.
      // Description contains 'amazon': +25.
      let score = 50;
      score += Math.max(0, 25 - distance * 6);
      if (desc.includes('amazon') || desc.includes('amzn') || desc.includes('prime')) score += 25;
      return score;
    }
    case 'venmo': {
      // Base 50. Amount exact: +40. Date within ±2 days: +20. Desc 'venmo': +20.
      let score = 50;
      if (exactAmount) score += 40;
      if (distance <= 2) score += 20;
      if (desc.includes('venmo')) score += 20;
      return score;
    }
    case 'apple': {
      // Base 50. Amount exact: +35. Date within ±2 days: +20. Desc 'apple': +25.
      let score = 50;
      if (exactAmount) score += 35;
      if (distance <= 2) score += 20;
      if (desc.includes('apple')) score += 25;
      return score;
    }
    case 'etsy': {
      // Base 50. Amount within $0.01: +35. Date within ±5 days: +20. Desc 'etsy': +25.
      let score = 50;
      if (exactAmount) score += 35;
      if (distance <= 5) score += 20;
      if (desc.includes('etsy')) score += 25;
      return score;
    }
  }
}

export function thresholdFor(vendor: VendorHint): number {
  switch (vendor) {
    case 'amazon': return 60;
    case 'venmo':  return 70;
    case 'apple':  return 65;
    case 'etsy':   return 60;
  }
}

export function classify(score: number, vendor: VendorHint): MatchType {
  const t = thresholdFor(vendor);
  if (score < t) return null;
  if (score >= t + 20) return 'exact';
  if (score >= t + 10) return 'probable';
  return 'possible';
}

export interface PickBestOpts {
  candidates: MatchCandidate[];
  parsed: ParsedForMatch;
  vendor: VendorHint;
}

export function pickBestMatch(opts: PickBestOpts): MatchResult | null {
  let best: MatchResult | null = null;
  for (const candidate of opts.candidates) {
    const score = scoreMatch(candidate, opts.parsed, opts.vendor);
    const match_type = classify(score, opts.vendor);
    if (match_type === null) continue;
    if (!best || score > best.score) {
      best = { transaction_id: candidate.transaction_id, score, match_type };
    }
  }
  return best;
}
