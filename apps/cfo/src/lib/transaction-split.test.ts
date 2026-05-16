import { describe, it, expect } from 'vitest';
import { cleanItemName, computeAppleSplits, deriveDescription, normalizeSupplement } from './transaction-split';
import type { AppleContext } from './email-parsers/apple';
import type { VenmoContext } from './email-parsers/venmo';

function apple(items: Array<{ name: string; price: number }>): AppleContext {
  return { receipt_id: 'M123', total_amount: 0, items, date: '2026-05-06', date_is_from_body: true };
}

describe('cleanItemName', () => {
  it('collapses a title repeated in two cells', () => {
    expect(cleanItemName('Friends - Season 2 Friends - Season 2')).toBe('Friends - Season 2');
  });
  it('strips trailing "Renews ..." and "Report a Problem"', () => {
    expect(cleanItemName('GoPro Quik Subscribe to GoPro (Monthly) Renews Jun 6, 2026 Report a Problem'))
      .toBe('GoPro Quik Subscribe to GoPro (Monthly)');
  });
  it('strips "Report a Problem"', () => {
    expect(cleanItemName('Good Fortune Comedy Movie Rental Report a Problem'))
      .toBe('Good Fortune Comedy Movie Rental');
  });
});

describe('computeAppleSplits', () => {
  it('splits a 3-item receipt that sums exactly to the charge', () => {
    const rows = computeAppleSplits(29.97, apple([
      { name: 'Friends - Season 2', price: 17.99 },
      { name: 'GoPro Quik', price: 5.99 },
      { name: 'Good Fortune', price: 5.99 },
    ]));
    expect(rows).not.toBeNull();
    expect(rows!).toHaveLength(3);
    expect(rows!.map(r => r.amount)).toEqual([17.99, 5.99, 5.99]);
  });

  it('adds a tax & fees row for the remainder', () => {
    const rows = computeAppleSplits(29.97, apple([
      { name: 'Item A', price: 12.00 },
      { name: 'Item B', price: 15.00 },
    ]));
    expect(rows!).toHaveLength(3);
    expect(rows![2]!.description).toBe('Apple — tax & fees');
    expect(rows![2]!.amount).toBe(2.97);
    expect(rows!.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(29.97, 2);
  });

  it('preserves the sign of a negative (bank debit) charge', () => {
    const rows = computeAppleSplits(-23.98, apple([
      { name: 'Item A', price: 11.99 },
      { name: 'Item B', price: 11.99 },
    ]));
    expect(rows!.map(r => r.amount)).toEqual([-11.99, -11.99]);
  });

  it('returns null for a single-item receipt', () => {
    expect(computeAppleSplits(9.99, apple([{ name: 'One Thing', price: 9.99 }]))).toBeNull();
  });
});

describe('normalizeSupplement', () => {
  it('passes through a well-formed object', () => {
    const ok = { apple: { items: [{ name: 'A', price: 1 }] } };
    expect(normalizeSupplement(ok)).toEqual(ok);
  });
  it('recovers the legacy [{}, "<json>"] array shape', () => {
    const malformed = [{}, JSON.stringify({ apple: { receipt_id: null, items: [] } })];
    expect(normalizeSupplement(malformed)).toEqual({ apple: { receipt_id: null, items: [] } });
  });
  it('parses a value that was double-encoded as a string', () => {
    expect(normalizeSupplement({ venmo: JSON.stringify({ memo: 'Rent' }) }))
      .toEqual({ venmo: { memo: 'Rent' } });
  });
  it('parses a whole supplement stored as a JSON string', () => {
    expect(normalizeSupplement('{"apple":{"items":[]}}')).toEqual({ apple: { items: [] } });
  });
  it('returns an empty object for null or unrecoverable input', () => {
    expect(normalizeSupplement(null)).toEqual({});
    expect(normalizeSupplement('not json')).toEqual({});
  });
});

describe('deriveDescription', () => {
  it('uses the Venmo memo when present', () => {
    const v: VenmoContext = { direction: 'sent', counterparty: 'Jane Doe', memo: 'Pizza night', amount: 20, date: '2026-05-01' };
    expect(deriveDescription('venmo', v)).toBe('Pizza night');
  });
  it('falls back to the Venmo counterparty when there is no memo', () => {
    const v: VenmoContext = { direction: 'sent', counterparty: 'Jane Doe', memo: null, amount: 20, date: '2026-05-01' };
    expect(deriveDescription('venmo', v)).toBe('Jane Doe');
  });
  it('uses the item name for a single-item Apple receipt', () => {
    expect(deriveDescription('apple', apple([{ name: 'iCloud+ 200GB', price: 2.99 }]))).toBe('iCloud+ 200GB');
  });
  it('returns null for a multi-item Apple receipt (handled by splitting)', () => {
    expect(deriveDescription('apple', apple([
      { name: 'A', price: 1 }, { name: 'B', price: 2 },
    ]))).toBeNull();
  });
});
