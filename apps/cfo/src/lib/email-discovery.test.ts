import { describe, it, expect } from 'vitest';
import { merchantQuery, parseDiscoveryResponse } from './email-discovery';

describe('merchantQuery', () => {
  it('prefers the cleaner Teller counterparty name', () => {
    expect(merchantQuery('Vrbo', 'VRBO* HA-1234567 +1.800...')).toBe('vrbo');
  });

  it('strips ref/store numbers and noise out of a raw descriptor', () => {
    expect(merchantQuery(null, 'UBER *TRIP 8005928996')).toBe('uber trip');
  });

  it('drops processor noise words', () => {
    expect(merchantQuery(null, 'AIRBNB PAYMENT 9928')).toBe('airbnb');
  });

  it('returns null when nothing usable remains', () => {
    expect(merchantQuery(null, 'POS 12345 #99')).toBeNull();
  });
});

describe('parseDiscoveryResponse', () => {
  it('parses a clean JSON match', () => {
    const m = parseDiscoveryResponse(
      '{"matched": true, "email_number": 2, "description": "VRBO — beach house", "confidence": "high"}',
    );
    expect(m).toEqual({ matched: true, email_number: 2, description: 'VRBO — beach house', confidence: 'high' });
  });

  it('tolerates a ```json fenced block with surrounding prose', () => {
    const m = parseDiscoveryResponse('Here you go:\n```json\n{"matched": false, "email_number": null, "description": null, "confidence": "low"}\n```');
    expect(m!.matched).toBe(false);
    expect(m!.confidence).toBe('low');
  });

  it('coerces an unknown confidence to "low"', () => {
    const m = parseDiscoveryResponse('{"matched": true, "email_number": 1, "description": "x", "confidence": "certain"}');
    expect(m!.confidence).toBe('low');
  });

  it('returns null for unparseable output', () => {
    expect(parseDiscoveryResponse('no json here')).toBeNull();
  });
});
