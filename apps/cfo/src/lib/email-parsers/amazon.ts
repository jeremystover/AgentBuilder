// Vendor regexes are a calibration baseline — re-validate against fresh
// samples in docs/email-samples.md before relying on these in prod.

import type { GmailMessage } from '../gmail';
import { getMessageBody, getHeader } from '../gmail';

export interface AmazonContext {
  order_id: string;
  order_date: string | null;
  shipment_date: string | null;
  total_amount: number | null;
  items: Array<{ name: string }>;
  ship_to: string | null;
  shipping_address: string | null;
  order_status: 'Confirmed' | 'Shipped' | 'Delivered';
}

const ORDER_ID_RE = /(\d{3}-\d{7}-\d{7})/;

function extractOrderId(text: string): string | null {
  return text.match(ORDER_ID_RE)?.[1] ?? null;
}

function extractAmount(text: string): number | null {
  const patterns = [
    /(?:Order Total|Grand Total|Total for this order|Total charged|Order total):?\s*\$?([\d,]+\.\d{2})/i,
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

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function epochToIsoDate(epochMs: string): string {
  return new Date(parseInt(epochMs, 10)).toISOString().slice(0, 10);
}

function productsFromSubject(subject: string): string[] {
  const m = subject.match(/your amazon\.com order of (.+?)(?:\s*\(#|\s*$)/i);
  if (!m) return [];
  const name = m[1]!.trim();
  if (/^\d+ items?$/i.test(name)) return [];
  return [name];
}

function productsFromHtml(html: string): string[] {
  const names: string[] = [];
  const re = /<a\b[^>]*\/dp\/[^"']*["'][^>]*>\s*([^<]{4,120}?)\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const name = m[1]!.trim();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function extractShipping(text: string): { shipTo: string | null; address: string | null } {
  const m = text.match(/(?:Shipping to|Ships to|Ship to):?\s*([\w\s]+?)\s*\n([\w\s,\.]+,\s*[A-Z]{2}\s*\d{5})/i);
  if (m) return { shipTo: m[1]!.trim(), address: `${m[1]!.trim()}, ${m[2]!.trim()}` };
  return { shipTo: null, address: null };
}

export function parseAmazonEmail(message: GmailMessage): AmazonContext | null {
  try {
    const subject = getHeader(message, 'subject');
    const from = getHeader(message, 'from');

    const isAmazonSender = /auto-confirm@amazon\.com|shipment-tracking@amazon\.com|order-update@amazon\.com|ship-confirm@amazon\.com/i.test(from);
    if (!isAmazonSender) return null;

    const isOrderConfirmation = /your amazon\.com order of/i.test(subject);
    const isShipment = /has shipped/i.test(subject) && /amazon/i.test(subject);
    const isDelivery = /delivered/i.test(subject) && /amazon/i.test(subject);
    if (!isOrderConfirmation && !isShipment && !isDelivery) return null;

    const { text, html } = getMessageBody(message);
    const bodyText = text || stripHtml(html);

    const orderId = extractOrderId(subject) ?? extractOrderId(bodyText);
    if (!orderId) return null;

    const receivedDate = epochToIsoDate(message.internalDate);
    const totalAmount = isOrderConfirmation ? extractAmount(bodyText) : null;
    const orderDate = isOrderConfirmation ? receivedDate : null;
    const shipmentDate = isShipment ? receivedDate : null;

    const productNames = [
      ...productsFromHtml(html),
      ...productsFromSubject(subject),
    ].filter((v, i, a) => a.indexOf(v) === i);

    const { shipTo, address } = extractShipping(bodyText);

    return {
      order_id: orderId,
      order_date: orderDate,
      shipment_date: shipmentDate,
      total_amount: totalAmount,
      items: (productNames.length > 0 ? productNames : [`Amazon Order ${orderId}`]).map(name => ({ name })),
      ship_to: shipTo,
      shipping_address: address,
      order_status: isOrderConfirmation ? 'Confirmed' : isShipment ? 'Shipped' : 'Delivered',
    };
  } catch (err) {
    console.warn('[amazon-parser] failed:', err);
    return null;
  }
}
