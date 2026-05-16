/**
 * eBay order-confirmation email parser.
 *
 * eBay sends one "Order confirmed: <item>" email per purchase, and each
 * eBay order is a single item — the item title is carried in the subject.
 * There is nothing to split; enrichment just sets a readable description
 * and exposes the order total for bank matching.
 */

import type { GmailMessage } from '../gmail';
import { getMessageBody, getHeader } from '../gmail';

export interface EbayContext {
  order_id: string | null;
  item_name: string | null;
  total_amount: number | null;
  date: string;
}

const ORDER_ID_RE = /\b(\d{2}-\d{5}-\d{5})\b/;

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

function extractAmount(text: string): number | null {
  const patterns = [
    /(?:Order total|Total paid|Amount paid|You paid|Total)[:\s]*\$([\d,]+\.\d{2})/i,
    /\$([\d,]+\.\d{2})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseFloat(m[1]!.replace(/,/g, ''));
      if (isFinite(n) && n > 0.01) return n;
    }
  }
  return null;
}

export function parseEbayEmail(message: GmailMessage): EbayContext | null {
  try {
    const subject = getHeader(message, 'subject');
    const from = getHeader(message, 'from');

    const subjectMatch = subject.match(/order confirmed:\s*(.+)$/i);
    if (!subjectMatch) return null;
    if (!/ebay/i.test(from)) return null;

    const { text, html } = getMessageBody(message);
    const bodyText = text || stripHtml(html);

    return {
      order_id: subject.match(ORDER_ID_RE)?.[1] ?? bodyText.match(ORDER_ID_RE)?.[1] ?? null,
      item_name: subjectMatch[1]!.trim() || null,
      total_amount: extractAmount(bodyText),
      date: epochToIsoDate(message.internalDate),
    };
  } catch (err) {
    console.warn('[ebay-parser] failed:', err);
    return null;
  }
}
