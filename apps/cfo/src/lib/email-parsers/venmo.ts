/**
 * Venmo email parser. Adapted from the legacy CFO venmo-email.ts.
 */

import type { GmailMessage } from '../gmail';
import { getMessageBody, getHeader } from '../gmail';

export type VenmoDirection = 'sent' | 'received' | 'charged';

export interface VenmoContext {
  direction: VenmoDirection;
  counterparty: string;
  memo: string | null;
  amount: number;
  date: string;
}

function epochToIsoDate(epochMs: string): string {
  return new Date(parseInt(epochMs, 10)).toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseAmount(raw: string): number | null {
  const n = parseFloat(raw.replace(/[$,]/g, ''));
  return isFinite(n) && n > 0 ? n : null;
}

export function parseVenmoEmail(message: GmailMessage): VenmoContext | null {
  try {
    const from = getHeader(message, 'from');
    if (!/venmo@venmo\.com/i.test(from)) return null;

    const subject = getHeader(message, 'subject');

    let direction: VenmoDirection | null = null;
    let counterparty: string | null = null;
    let subjectAmount: number | null = null;

    const receivedMatch = subject.match(/^(.+?)\s+paid you\s+\$([\d,]+\.\d{2})/i);
    if (receivedMatch) {
      direction = 'received';
      counterparty = receivedMatch[1]!.trim();
      subjectAmount = parseAmount(receivedMatch[2]!);
    }

    const sentMatch = !direction && subject.match(/^You paid\s+(.+?)\s+\$([\d,]+\.\d{2})/i);
    if (sentMatch) {
      direction = 'sent';
      counterparty = sentMatch[1]!.trim();
      subjectAmount = parseAmount(sentMatch[2]!);
    }

    const chargedMatch = !direction && subject.match(/^(.+?)\s+charged you\s+\$([\d,]+\.\d{2})/i);
    if (chargedMatch) {
      direction = 'charged';
      counterparty = chargedMatch[1]!.trim();
      subjectAmount = parseAmount(chargedMatch[2]!);
    }

    if (!direction || !counterparty || subjectAmount === null) return null;

    const { text, html } = getMessageBody(message);
    const body = text || stripHtml(html);

    let memo: string | null = null;
    const forMatch = body.match(/For\s+"([^"]+)"/i) ?? body.match(/For\s+(.{3,80}?)(?:\n|$)/i);
    if (forMatch) memo = forMatch[1]!.trim();

    let amount: number = subjectAmount;
    if (!amount) {
      const bodyAmountMatch = body.match(/\$([\d,]+\.\d{2})/);
      if (bodyAmountMatch) amount = parseAmount(bodyAmountMatch[1]!) ?? 0;
    }
    if (!amount) return null;

    return {
      direction,
      counterparty,
      memo,
      amount,
      date: epochToIsoDate(message.internalDate),
    };
  } catch (err) {
    console.warn('[venmo-parser] failed:', err);
    return null;
  }
}
