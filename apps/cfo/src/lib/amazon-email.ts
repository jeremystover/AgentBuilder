import type { GmailMessage } from './gmail';
import { getMessageBody, getHeader } from './gmail';

export interface AmazonEmailOrder {
  orderId: string;
  orderDate: string | null;
  shipmentDate: string | null;
  totalAmount: number | null;
  productNames: string[];
  sellerNames: string[];
  shipTo: string | null;
  shippingAddress: string | null;
  paymentInstrumentType: string | null;
  orderStatus: string | null;
}

const ORDER_ID_RE = /(\d{3}-\d{7}-\d{7})/;

function extractOrderId(text: string): string | null {
  return text.match(ORDER_ID_RE)?.[1] ?? null;
}

function extractAmount(text: string): number | null {
  // Match "Order Total:", "Grand Total:", etc. followed by a dollar amount.
  // We try the labeled patterns first to avoid picking up individual item prices.
  const patterns = [
    /(?:Order Total|Grand Total|Total for this order|Total charged|Order total):?\s*\$?([\d,]+\.\d{2})/i,
    /\$([\d,]+\.\d{2})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
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

// Pull the product description out of Amazon's email subject line.
// "Your Amazon.com order of Silicone Baking Mat (#112-...)" → "Silicone Baking Mat"
// "Your Amazon.com order of 3 items (#112-...)"            → [] (skip generic)
function productsFromSubject(subject: string): string[] {
  const m = subject.match(/your amazon\.com order of (.+?)(?:\s*\(#|\s*$)/i);
  if (!m) return [];
  const name = m[1].trim();
  if (/^\d+ items?$/i.test(name)) return [];
  return [name];
}

// Pull product names from Amazon HTML email by matching product detail page links.
function productsFromHtml(html: string): string[] {
  const names: string[] = [];
  const re = /<a\b[^>]*\/dp\/[^"']*["'][^>]*>\s*([^<]{4,120}?)\s*<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const name = m[1].trim();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function extractShipping(text: string): { shipTo: string | null; address: string | null } {
  // "Shipping to:\nJohn Smith\n123 Main St, Springfield, IL 62701"
  const m = text.match(/(?:Shipping to|Ships to|Ship to):?\s*([\w\s]+?)\s*\n([\w\s,\.]+,\s*[A-Z]{2}\s*\d{5})/i);
  if (m) return { shipTo: m[1].trim(), address: `${m[1].trim()}, ${m[2].trim()}` };
  return { shipTo: null, address: null };
}

export function parseAmazonEmail(message: GmailMessage): AmazonEmailOrder | null {
  const subject = getHeader(message, 'subject');
  const from = getHeader(message, 'from');

  const isAmazonSender = /auto-confirm@amazon\.com|shipment-tracking@amazon\.com|order-update@amazon\.com/i.test(from);
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

  // Order confirmation emails carry the total; shipment/delivery emails do not.
  const totalAmount = isOrderConfirmation ? extractAmount(bodyText) : null;
  const orderDate = isOrderConfirmation ? receivedDate : null;
  const shipmentDate = isShipment ? receivedDate : null;

  const productNames = [
    ...productsFromHtml(html),
    ...productsFromSubject(subject),
  ].filter((v, i, a) => a.indexOf(v) === i);

  const { shipTo, address } = extractShipping(bodyText);

  return {
    orderId,
    orderDate,
    shipmentDate,
    totalAmount,
    productNames: productNames.length > 0 ? productNames : [`Amazon Order ${orderId}`],
    sellerNames: [],
    shipTo,
    shippingAddress: address,
    paymentInstrumentType: null,
    orderStatus: isOrderConfirmation ? 'Confirmed' : isShipment ? 'Shipped' : 'Delivered',
  };
}
