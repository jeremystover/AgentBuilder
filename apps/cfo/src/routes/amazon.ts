import type { AmazonOrder, Env } from '../types';
import { jsonError, jsonOk, getUserId } from '../types';
import { parseCsv } from '../lib/dedup';
import { aggregateAmazonRows, matchAmazonOrderToTransaction } from '../lib/amazon';
import { handleClassifySingle } from './classify';

export interface AmazonAggregatedOrder {
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

export interface ProcessResult {
  stored: number;
  matched: number;
  reclassified: number;
  unmatched: number;
}

// Shared by the CSV import route and the nightly email sync.
// Inserts orders into amazon_orders (skipping any order_id already present),
// then attempts to match each new order to a bank transaction and reclassify.
export async function processAmazonOrders(
  env: Env,
  userId: string,
  importId: string,
  orders: AmazonAggregatedOrder[],
): Promise<ProcessResult> {
  let stored = 0, matched = 0, reclassified = 0, unmatched = 0;

  for (const order of orders) {
    // Dedup: skip if we already have this Amazon order ID in the DB.
    if (order.orderId) {
      const existing = await env.DB.prepare(
        `SELECT id FROM amazon_orders WHERE user_id = ? AND order_id = ? LIMIT 1`,
      ).bind(userId, order.orderId).first();
      if (existing) continue;
    }

    const orderId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO amazon_orders
         (id, user_id, import_id, order_key, order_id, order_date, shipment_date, total_amount,
          quantity_total, product_names, seller_names, order_status, payment_instrument_type,
          ship_to, shipping_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      orderId, userId, importId,
      order.orderKey, order.orderId, order.orderDate, order.shipmentDate,
      order.totalAmount, order.quantityTotal,
      JSON.stringify(order.productNames), JSON.stringify(order.sellerNames),
      order.orderStatus, order.paymentInstrumentType, order.shipTo, order.shippingAddress,
    ).run();
    stored++;

    const match = await matchAmazonOrderToTransaction(env, userId, {
      total_amount: order.totalAmount,
      order_date: order.orderDate,
      shipment_date: order.shipmentDate,
    });

    if (!match) { unmatched++; continue; }

    await env.DB.prepare(
      `INSERT INTO amazon_transaction_matches
         (id, user_id, amazon_order_id, transaction_id, match_score, match_method)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), userId, orderId, match.transactionId, match.score, match.method).run();
    matched++;

    const classification = await env.DB.prepare(
      `SELECT method, is_locked FROM classifications WHERE transaction_id = ?`,
    ).bind(match.transactionId).first<{ method: string | null; is_locked: number }>();

    if (classification?.is_locked || classification?.method === 'manual' || classification?.method === 'historical') {
      continue;
    }

    if (classification) {
      await env.DB.prepare('DELETE FROM classifications WHERE transaction_id = ?').bind(match.transactionId).run();
    }

    const classifyResponse = await handleClassifySingle(
      new Request('https://internal/classify', { headers: { 'x-user-id': userId } }),
      env,
      match.transactionId,
    );
    if (classifyResponse.ok) reclassified++;
  }

  return { stored, matched, reclassified, unmatched };
}

export async function handleAmazonImport(request: Request, env: Env): Promise<Response> {
  const userId = getUserId(request);

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return jsonError('Expected multipart/form-data with a "file" field'); }

  const fileField = formData.get('file');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!fileField || typeof (fileField as any).text !== 'function') return jsonError('"file" field is required');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const csvText = await (fileField as any).text() as string;
  const rows = parseCsv(csvText);
  if (!rows.length) return jsonError('CSV file is empty or has no data rows');

  const importId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO imports (id, user_id, source, status, transactions_found)
     VALUES (?, ?, 'amazon', 'running', ?)`,
  ).bind(importId, userId, rows.length).run();

  const { aggregated, skipped } = aggregateAmazonRows(rows);
  const result = await processAmazonOrders(env, userId, importId, aggregated);

  await env.DB.prepare(
    `UPDATE imports
     SET status='completed', transactions_found=?, transactions_imported=?, completed_at=datetime('now')
     WHERE id = ?`,
  ).bind(rows.length, result.stored, importId).run();

  return jsonOk({
    import_id: importId,
    rows_parsed: rows.length,
    amazon_orders_imported: result.stored,
    rows_skipped: skipped,
    transactions_matched: result.matched,
    transactions_unmatched: result.unmatched,
    transactions_reclassified: result.reclassified,
    message: result.matched
      ? 'Amazon orders were imported, matched to bank transactions, and matched transactions were reclassified when allowed.'
      : 'Amazon orders were imported, but no matching bank transactions were found yet.',
  }, 201);
}

// Kept for type compatibility with lib/amazon.ts callers.
export type { AmazonOrder };
