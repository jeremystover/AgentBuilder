import type { GmailMessage } from './gmail';
import { getMessageBody, getHeader } from './gmail';

export interface EtsyReceiptItem {
  name: string;
  price: number;
}

export interface EtsyEmailReceipt {
  orderId: string | null;
  shopName: string | null;
  totalAmount: number;
  items: EtsyReceiptItem[];
  date: string; // YYYY-MM-DD, from email received date
  gmailMessageId: string;
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

function parsePrice(raw: string): number | null {
  const n = parseFloat(raw.replace(/[$,]/g, ''));
  return isFinite(n) && n >= 0 ? n : null;
}

// Extract order ID from subject or body.
// Etsy uses "#1234567890", "Order #1234567890", or "(3606814426)" in subject.
function extractOrderId(text: string): string | null {
  return (
    text.match(/(?:order\s*)?#(\d{9,})/i)?.[1] ??
    text.match(/\((\d{9,})\)/)?.[1] ??
    null
  );
}

// Extract the grand total — prefer labeled "Order total" / "Total" over item prices.
// Use last match so "Order total" wins over any "Subtotal" line.
function extractTotal(text: string): number | null {
  // Handle formats like "Total $24.39" and "Total (1 item) $24.39"
  const re = /(?<![a-zA-Z])total[^$\n]{0,20}\$?([\d,]+\.\d{2})/gi;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last) {
    const n = parsePrice(last);
    if (n !== null && n > 0) return n;
  }
  // Fallback: "charged $X.XX" or any standalone dollar amount
  const fallback = text.match(/charged[:\s]+\$?([\d,]+\.\d{2})/i)
    ?? text.match(/\$(\d+\.\d{2})/);
  if (fallback) {
    const n = parsePrice(fallback[1]);
    if (n !== null && n > 0) return n;
  }
  return null;
}

// Extract shop name from subject line.
// "You just bought [item] from [Shop Name]" → "Shop Name"
// "Receipt for your Etsy order from [Shop Name]" → "Shop Name"
function extractShopFromSubject(subject: string): string | null {
  return subject.match(/from\s+([^(]+?)(?:\s*\(|$)/i)?.[1]?.trim() ?? null;
}

// Extract items from Etsy receipt HTML table rows.
function extractItemsFromHtml(html: string): EtsyReceiptItem[] {
  const items: EtsyReceiptItem[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowText = stripHtml(rowMatch[1]).trim();
    if (!rowText) continue;
    if (/\b(subtotal|shipping|tax|total|discount|coupon)\b/i.test(rowText)) continue;

    const priceMatch = rowText.match(/\$([\d,]+\.\d{2})/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]);
    if (price === null || price === 0) continue;

    const name = rowText.slice(0, rowText.lastIndexOf(priceMatch[0]))
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (name.length >= 2) items.push({ name, price });
  }

  return items;
}

// Fallback plain-text item extraction.
function extractItemsFromText(text: string): EtsyReceiptItem[] {
  const items: EtsyReceiptItem[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (/\b(subtotal|shipping|tax|total|discount|coupon|receipt|order)\b/i.test(line)) continue;

    const priceMatch = line.match(/\$([\d,]+\.\d{2})\s*$/);
    if (!priceMatch) continue;
    const price = parsePrice(priceMatch[1]);
    if (price === null || price === 0) continue;

    const name = line.slice(0, line.lastIndexOf(priceMatch[0])).trim();
    if (name.length >= 2) items.push({ name, price });
  }
  return items;
}

export function parseEtsyEmail(message: GmailMessage): EtsyEmailReceipt | null {
  const from = getHeader(message, 'from');
// Etsy sends from transaction@account.etsy.com (not transaction@etsy.com)
  if (!/@etsy\.com/i.test(from)) return null;

  const subject = getHeader(message, 'subject');
  // Match order confirmations: "Your Etsy Purchase from...", "Your order is confirmed", etc.
  if (!/receipt|you just bought|order confirmed|etsy purchase|purchase from/i.test(subject)) return null;

  const { text, html } = getMessageBody(message);
  const bodyText = text || stripHtml(html);

  const orderId = extractOrderId(subject) ?? extractOrderId(bodyText);
  const shopName = extractShopFromSubject(subject)
    ?? bodyText.match(/(?:from|shop(?:ped\s+at)?)[:\s]+([A-Z][^$\n]{3,40}?)(?:\n|\s{2}|$)/)?.[1]?.trim()
    ?? null;

  const totalAmount = extractTotal(bodyText);
  if (!totalAmount) return null;

  const items = html ? extractItemsFromHtml(html) : [];
  const finalItems = items.length > 0 ? items : extractItemsFromText(bodyText);

  return {
    orderId,
    shopName,
    totalAmount,
    items: finalItems,
    date: epochToIsoDate(message.internalDate),
    gmailMessageId: message.id,
  };
}
