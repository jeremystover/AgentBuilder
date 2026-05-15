/**
 * Apple receipt email parser. Adapted from the legacy CFO apple-email.ts.
 * Handles both direct and forwarded receipts — when forwarded, the email
 * `internalDate` is the forward time so we prefer dates extracted from
 * the body when available.
 */

import type { GmailMessage } from '../gmail';
import { getMessageBody, getHeader } from '../gmail';

export interface AppleContext {
  receipt_id: string | null;
  total_amount: number;
  items: Array<{ name: string; price: number }>;
  date: string;
  date_is_from_body: boolean;
}

const RECEIPT_ID_RE = /\bM\d{9,}\b/;

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

function parsePrice(raw: string): number | null {
  const n = parseFloat(raw.replace(/[$,]/g, ''));
  return isFinite(n) && n >= 0 ? n : null;
}

function extractTotal(text: string): number | null {
  const patterns = [
    /(?:order\s+)?total[:\s]+\$?([\d,]+\.\d{2})/i,
    /charged[:\s]+\$?([\d,]+\.\d{2})/i,
    /amount[:\s]+\$?([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parsePrice(m[1]!);
      if (n !== null && n > 0) return n;
    }
  }
  return null;
}

function extractItemsFromHtml(html: string): Array<{ name: string; price: number }> {
  const items: Array<{ name: string; price: number }> = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowText = stripHtml(rowMatch[1]!).trim();
    if (!rowText) continue;
    if (/\b(subtotal|tax|total|billed\s+to|apple\s+id)\b/i.test(rowText)) continue;
    const priceMatch = rowText.match(/\$([\d,]+\.\d{2})/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]!);
    if (price === null) continue;
    const beforePrice = rowText.slice(0, rowText.lastIndexOf(priceMatch[0])).trim();
    const name = beforePrice
      .replace(/\bIn-App Purchase\b/gi, '')
      .replace(/\bSubscription\b/gi, '')
      .replace(/\b\d+\.\d\s*\(\d+\s*Ratings?\)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (name.length >= 2) items.push({ name, price });
  }
  return items;
}

function extractDateFromBody(text: string): string | null {
  const months = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const mdy = new RegExp(`(${months})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`, 'i');
  const iso = /\b(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/;

  const mdyMatch = text.match(mdy);
  if (mdyMatch) {
    const d = new Date(`${mdyMatch[1]} ${mdyMatch[2]}, ${mdyMatch[3]}`);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const isoMatch = text.match(iso);
  if (isoMatch) return isoMatch[0];
  return null;
}

function extractItemsFromText(text: string): Array<{ name: string; price: number }> {
  const items: Array<{ name: string; price: number }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (/\b(subtotal|tax|total|billed\s+to|apple\s+id|receipt|order\s+id)\b/i.test(line)) continue;
    const priceMatch = line.match(/\$([\d,]+\.\d{2})\s*$/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]!);
    if (price === null) continue;
    const name = line.slice(0, line.lastIndexOf(priceMatch[0])).trim();
    if (name.length >= 2) items.push({ name, price });
  }
  return items;
}

export function parseAppleEmail(message: GmailMessage): AppleContext | null {
  try {
    const subject = getHeader(message, 'subject');
    if (!/receipt from apple/i.test(subject)) return null;

    const { text, html } = getMessageBody(message);
    const bodyText = text || stripHtml(html);

    const receiptId =
      subject.match(RECEIPT_ID_RE)?.[0] ??
      bodyText.match(RECEIPT_ID_RE)?.[0] ??
      null;

    const totalAmount = extractTotal(bodyText);
    if (!totalAmount) return null;

    const fromHtml = html ? extractItemsFromHtml(html) : [];
    const items = fromHtml.length > 0 ? fromHtml : extractItemsFromText(bodyText);

    const bodyDate = extractDateFromBody(bodyText);

    return {
      receipt_id: receiptId,
      total_amount: totalAmount,
      items,
      date: bodyDate ?? epochToIsoDate(message.internalDate),
      date_is_from_body: bodyDate !== null,
    };
  } catch (err) {
    console.warn('[apple-parser] failed:', err);
    return null;
  }
}
