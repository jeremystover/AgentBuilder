import type { GmailMessage } from './gmail';
import { getMessageBody, getHeader } from './gmail';

export interface AppleReceiptItem {
  name: string;
  price: number;
}

export interface AppleEmailReceipt {
  receiptId: string | null;
  totalAmount: number;
  items: AppleReceiptItem[];
  date: string; // YYYY-MM-DD, from email received date
  gmailMessageId: string;
}

// Apple receipt ID format: M followed by 9+ digits, e.g. M123456789
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

// Extract the grand total from plain text.
// Looks for "Total $X.XX" or "Order Total $X.XX" or "TOTAL $X.XX".
function extractTotal(text: string): number | null {
  const patterns = [
    /(?:order\s+)?total[:\s]+\$?([\d,]+\.\d{2})/i,
    /charged[:\s]+\$?([\d,]+\.\d{2})/i,
    /amount[:\s]+\$?([\d,]+\.\d{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parsePrice(m[1]);
      if (n !== null && n > 0) return n;
    }
  }
  return null;
}

// Extract items from Apple receipt HTML.
// Apple receipts use a table layout: each product row has the item name in one
// cell and the price in an adjacent cell. We scan for price-looking cells and
// grab the nearest preceding text as the item name.
function extractItemsFromHtml(html: string): AppleReceiptItem[] {
  const items: AppleReceiptItem[] = [];

  // Match table rows that contain a dollar amount — these are line-item rows.
  // Each <tr> may contain several <td> cells; we want the last price cell and
  // the first text-bearing cell in the same row.
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const rowText = stripHtml(rowHtml).trim();

    // Skip header/footer rows and the grand-total row (we handle total separately)
    if (/^\s*$/.test(rowText)) continue;
    if (/\b(subtotal|tax|total|billed\s+to|apple\s+id)\b/i.test(rowText)) continue;

    // Find a price in this row ($X.XX or FREE)
    const priceMatch = rowText.match(/\$([\d,]+\.\d{2})/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]);
    if (price === null) continue;

    // The item name is everything before the price, stripped and trimmed.
    const beforePrice = rowText.slice(0, rowText.lastIndexOf(priceMatch[0])).trim();
    // Clean up common noise: developer names, "In-App Purchase", ratings, etc.
    const name = beforePrice
      .replace(/\bIn-App Purchase\b/gi, '')
      .replace(/\bSubscription\b/gi, '')
      .replace(/\b\d+\.\d\s*\(\d+\s*Ratings?\)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (name.length >= 2) {
      items.push({ name, price });
    }
  }

  return items;
}

// Fallback: extract items from plain text when HTML parsing yields nothing.
// Apple plain-text receipts list each item as:
//   "Item Name    $X.XX"
// with the price right-aligned on the same line.
function extractItemsFromText(text: string): AppleReceiptItem[] {
  const items: AppleReceiptItem[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    // Skip separator lines, headers, and totals
    if (/^\s*$/.test(line)) continue;
    if (/\b(subtotal|tax|total|billed\s+to|apple\s+id|receipt|order\s+id)\b/i.test(line)) continue;

    const priceMatch = line.match(/\$([\d,]+\.\d{2})\s*$/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]);
    if (price === null) continue;

    const name = line.slice(0, line.lastIndexOf(priceMatch[0])).trim();
    if (name.length >= 2) {
      items.push({ name, price });
    }
  }

  return items;
}

export function parseAppleEmail(message: GmailMessage): AppleEmailReceipt | null {
  const from = getHeader(message, 'from');
  if (!/no_reply@email\.apple\.com/i.test(from)) return null;

  const subject = getHeader(message, 'subject');
  // Apple sends many email types — only process purchase receipts.
  if (!/receipt/i.test(subject)) return null;

  const { text, html } = getMessageBody(message);
  const bodyText = text || stripHtml(html);

  // Receipt ID from subject ("Your receipt No. M123456789 from Apple.") or body
  const receiptId =
    subject.match(RECEIPT_ID_RE)?.[0] ??
    bodyText.match(RECEIPT_ID_RE)?.[0] ??
    null;

  const totalAmount = extractTotal(bodyText);
  if (!totalAmount) return null;

  const items = html
    ? extractItemsFromHtml(html)
    : extractItemsFromText(bodyText);

  // If HTML parsing missed items, fall back to text
  const finalItems = items.length > 0 ? items : extractItemsFromText(bodyText);

  return {
    receiptId,
    totalAmount,
    items: finalItems,
    date: epochToIsoDate(message.internalDate),
    gmailMessageId: message.id,
  };
}
