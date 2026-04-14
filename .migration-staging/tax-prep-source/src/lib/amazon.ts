import type { AmazonContext, AmazonOrder, Env, Transaction } from '../types';
import { cleanDescription } from './dedup';

type AmazonCsvRow = Record<string, string>;

interface AmazonParsedRow {
  orderId: string | null;
  orderDate: string | null;
  shipmentDate: string | null;
  totalAmount: number;
  quantity: number;
  productName: string;
  sellerName: string | null;
  orderStatus: string | null;
  paymentInstrumentType: string | null;
  shipTo: string | null;
  shippingAddress: string | null;
}

interface AmazonAggregatedOrder {
  orderKey: string;
  orderId: string | null;
  orderDate: string | null;
  shipmentDate: string | null;
  totalAmount: number;
  quantityTotal: number;
  productNames: string[];
  sellerNames: string[];
  orderStatus: string | null;
  paymentInstrumentType: string | null;
  shipTo: string | null;
  shippingAddress: string | null;
}

function pick(row: AmazonCsvRow, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value && value.trim()) return value.trim();
  }
  return '';
}

function normalizeDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    const month = match[1].padStart(2, '0');
    const day = match[2].padStart(2, '0');
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '').trim();
  if (!cleaned) return null;
  const amount = Number.parseFloat(cleaned);
  return Number.isFinite(amount) ? Math.abs(amount) : null;
}

function pickAmount(row: AmazonCsvRow, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (!value || !value.trim()) continue;
    const amount = parseAmount(value);
    if (amount !== null) return amount;
  }
  return null;
}

function parseQuantity(raw: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function buildOrderKey(row: AmazonParsedRow): string {
  return [
    row.orderId ?? 'unknown-order',
    row.shipmentDate ?? row.orderDate ?? 'unknown-date',
    row.totalAmount.toFixed(2),
  ].join('|');
}

function shiftIsoDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function distanceInDays(a: string, b: string): number {
  const aMs = new Date(`${a}T00:00:00.000Z`).getTime();
  const bMs = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.round(Math.abs(aMs - bMs) / 86400000);
}

export function inferAmazonDestination(address: string | null): AmazonContext['inferred_destination'] {
  const haystack = (address ?? '').toLowerCase();
  if (!haystack) return null;
  if (haystack.includes('grandey')) return 'whitford_house';
  if (haystack.includes('edna')) return 'family_home';
  return null;
}

export function parseAmazonRow(row: AmazonCsvRow): AmazonParsedRow | null {
  const productName = pick(row, 'product_name', 'item_title', 'title', 'product');
  const totalAmount = pickAmount(
    row,
    'total_amount',
    'payment_amount',
    'total_owed',
    'order_total',
    'order_net_total',
    'item_total',
    'item_net_total',
    'subtotal',
    'total_charged',
  );
  const orderDate = normalizeDate(pick(row, 'order_date', 'date'));
  const shipmentDate = normalizeDate(pick(row, 'shipment_date', 'ship_date', 'delivery_date', 'payment_date'));

  if (!productName || totalAmount === null) return null;

  return {
    orderId: pick(row, 'order_id', 'amazon_order_id') || null,
    orderDate,
    shipmentDate,
    totalAmount,
    quantity: parseQuantity(pick(row, 'quantity', 'order_quantity', 'item_quantity', 'received_quantity')),
    productName,
    sellerName: pick(row, 'seller', 'seller_name') || null,
    orderStatus: pick(row, 'order_status', 'shipment_status', 'status') || null,
    paymentInstrumentType: pick(row, 'payment_instrument_type', 'payment_method') || null,
    shipTo: pick(row, 'ship_to', 'recipient', 'recipient_name') || null,
    shippingAddress: pick(row, 'shipping_address', 'ship_address', 'address') || null,
  };
}

export function aggregateAmazonRows(rows: AmazonCsvRow[]): {
  aggregated: AmazonAggregatedOrder[];
  skipped: number;
} {
  const grouped = new Map<string, AmazonAggregatedOrder>();
  let skipped = 0;

  for (const row of rows) {
    const parsed = parseAmazonRow(row);
    if (!parsed) {
      skipped++;
      continue;
    }

    const orderKey = buildOrderKey(parsed);
    const existing = grouped.get(orderKey) ?? {
      orderKey,
      orderId: parsed.orderId,
      orderDate: parsed.orderDate,
      shipmentDate: parsed.shipmentDate,
      totalAmount: parsed.totalAmount,
      quantityTotal: 0,
      productNames: [],
      sellerNames: [],
      orderStatus: parsed.orderStatus,
      paymentInstrumentType: parsed.paymentInstrumentType,
      shipTo: parsed.shipTo,
      shippingAddress: parsed.shippingAddress,
    };

    existing.quantityTotal += parsed.quantity;
    if (!existing.productNames.includes(parsed.productName)) existing.productNames.push(parsed.productName);
    if (parsed.sellerName && !existing.sellerNames.includes(parsed.sellerName)) existing.sellerNames.push(parsed.sellerName);
    if (!existing.orderDate && parsed.orderDate) existing.orderDate = parsed.orderDate;
    if (!existing.shipmentDate && parsed.shipmentDate) existing.shipmentDate = parsed.shipmentDate;
    if (!existing.shipTo && parsed.shipTo) existing.shipTo = parsed.shipTo;
    if (!existing.shippingAddress && parsed.shippingAddress) existing.shippingAddress = parsed.shippingAddress;

    grouped.set(orderKey, existing);
  }

  return { aggregated: Array.from(grouped.values()), skipped };
}

function looksLikeAmazonTransaction(transaction: Transaction): boolean {
  const haystack = `${transaction.merchant_name ?? ''} ${transaction.description}`.toLowerCase();
  return haystack.includes('amazon') || haystack.includes('amzn') || haystack.includes('prime');
}

export async function matchAmazonOrderToTransaction(
  env: Env,
  userId: string,
  order: Pick<AmazonOrder, 'total_amount' | 'order_date' | 'shipment_date'>,
): Promise<{ transactionId: string; score: number; method: string } | null> {
  const anchorDate = order.shipment_date ?? order.order_date;
  if (!anchorDate) return null;

  const dateFrom = shiftIsoDate(anchorDate, -4);
  const dateTo = shiftIsoDate(anchorDate, 12);

  const candidates = await env.DB.prepare(
    `SELECT t.*
     FROM transactions t
     LEFT JOIN amazon_transaction_matches atm ON atm.transaction_id = t.id
     WHERE t.user_id = ?
       AND atm.id IS NULL
       AND ABS(t.amount - ?) < 0.01
       AND t.posted_date BETWEEN ? AND ?
     ORDER BY t.posted_date ASC`,
  ).bind(userId, order.total_amount, dateFrom, dateTo).all<Transaction>();

  let best: { transactionId: string; score: number; method: string } | null = null;

  for (const candidate of candidates.results) {
    let score = 50;
    const distance = distanceInDays(candidate.posted_date, anchorDate);
    score += Math.max(0, 25 - distance * 5);
    if (looksLikeAmazonTransaction(candidate)) score += 25;
    if (order.order_date && candidate.posted_date === order.order_date) score += 10;
    if (order.shipment_date && candidate.posted_date === order.shipment_date) score += 10;

    if (!best || score > best.score) {
      best = { transactionId: candidate.id, score, method: looksLikeAmazonTransaction(candidate) ? 'amount_date_merchant' : 'amount_date' };
    }
  }

  return best && best.score >= 60 ? best : null;
}

export async function loadAmazonContext(env: Env, txId: string): Promise<AmazonContext | null> {
  const row = await env.DB.prepare(
    `SELECT ao.*
     FROM amazon_transaction_matches atm
     JOIN amazon_orders ao ON ao.id = atm.amazon_order_id
     WHERE atm.transaction_id = ?
     ORDER BY atm.created_at DESC
     LIMIT 1`,
  ).bind(txId).first<AmazonOrder>();

  if (!row) return null;

  let productNames: string[] = [];
  let sellerNames: string[] = [];
  try { productNames = JSON.parse(row.product_names) as string[]; }
  catch { productNames = row.product_names ? [row.product_names] : []; }
  try { sellerNames = JSON.parse(row.seller_names ?? '[]') as string[]; }
  catch { sellerNames = row.seller_names ? [row.seller_names] : []; }

  return {
    order_id: row.order_id,
    order_date: row.order_date,
    shipment_date: row.shipment_date,
    total_amount: row.total_amount,
    product_names: productNames,
    seller_names: sellerNames,
    ship_to: row.ship_to,
    shipping_address: row.shipping_address,
    inferred_destination: inferAmazonDestination(row.shipping_address),
  };
}

export function buildAmazonSearchText(context: AmazonContext | null): string {
  if (!context) return '';
  const productText = context.product_names.join(' ');
  const addressText = context.shipping_address ?? '';
  return cleanDescription(`${productText} ${addressText}`);
}
