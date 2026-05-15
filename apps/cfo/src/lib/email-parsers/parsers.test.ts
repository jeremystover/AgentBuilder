import { describe, it, expect } from 'vitest';
import type { GmailMessage } from '../gmail';
import { parseAppleEmail } from './apple';
import { parseEtsyEmail } from './etsy';

function msg(opts: { from: string; subject: string; body: string; internalDate?: string }): GmailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    internalDate: opts.internalDate ?? String(Date.UTC(2026, 4, 1)),
    payload: {
      mimeType: 'multipart/alternative',
      body: { size: 0 },
      headers: [
        { name: 'From', value: opts.from },
        { name: 'Subject', value: opts.subject },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from(opts.body, 'utf-8').toString('base64url'), size: opts.body.length },
        },
      ],
    },
  };
}

describe('parseAppleEmail', () => {
  it('parses a direct Apple receipt', () => {
    const ctx = parseAppleEmail(
      msg({
        from: 'Apple <no_reply@email.apple.com>',
        subject: 'Your receipt from Apple.',
        body: 'Apple ID: user@example.com\nDATE Jan 5, 2026\niCloud+ 200GB $2.99\nTotal: $2.99',
      }),
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.total_amount).toBe(2.99);
  });

  it('parses a forwarded Apple receipt and uses the body date, not the forward date', () => {
    const ctx = parseAppleEmail(
      msg({
        from: 'Elyse <elyse@example.com>',
        subject: 'Fwd: Your receipt from Apple.',
        body: '---------- Forwarded message ---------\nFrom: Apple <no_reply@email.apple.com>\nDATE Jan 5, 2026\nApp Store Purchase $9.99\nTotal: $9.99',
        internalDate: String(Date.UTC(2026, 3, 20)),
      }),
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.total_amount).toBe(9.99);
    expect(ctx!.date_is_from_body).toBe(true);
    expect(ctx!.date).toBe('2026-01-05');
  });
});

describe('parseEtsyEmail', () => {
  it('parses a forwarded Etsy receipt with an "Order Shipped" subject', () => {
    const ctx = parseEtsyEmail(
      msg({
        from: 'Elyse <elyse@example.com>',
        subject: 'Fwd: Your Etsy Order Shipped (Receipt #3910728518)',
        body: 'Handmade Mug $24.00\nShipping $5.00\nOrder total: $29.00',
      }),
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.order_id).toBe('3910728518');
    expect(ctx!.total_amount).toBe(29.0);
  });
});
