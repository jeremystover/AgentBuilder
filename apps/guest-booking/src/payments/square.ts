// Square Online Checkout integration.
//
// Square's equivalent of Stripe Checkout is a "Payment Link" created
// via /v2/online-checkout/payment-links.  The guest pays on a Square-
// hosted page and we get notified via a Square webhook when the
// `payment.updated` event reports a COMPLETED payment.
//
// Docs:
//   https://developer.squareup.com/reference/square/checkout-api/create-payment-link
//   https://developer.squareup.com/docs/webhooks/step3validate

import type { Env } from "../types";
import { hmacSha256Base64, timingSafeEqual } from "../hmac";

function squareBase(env: Env): string {
  return env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

export interface SquareCheckoutInput {
  booking_id: number;
  amount_cents: number;
  currency: string;
  description: string;
  guest_email?: string;
  redirect_url: string;
}

export async function createSquarePaymentLink(
  env: Env,
  input: SquareCheckoutInput
): Promise<{ id: string; url: string; order_id: string }> {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) {
    throw new Error("Square credentials not configured");
  }
  const body = {
    idempotency_key: `booking-${input.booking_id}-${Date.now()}`,
    quick_pay: {
      name: input.description,
      price_money: {
        amount: input.amount_cents,
        currency: input.currency.toUpperCase(),
      },
      location_id: env.SQUARE_LOCATION_ID,
    },
    checkout_options: {
      redirect_url: input.redirect_url,
      ask_for_shipping_address: false,
      // We stash our booking id in the reference so the webhook
      // handler can look the booking back up.
      merchant_support_email: undefined,
    },
    pre_populated_data: {
      buyer_email: input.guest_email,
    },
    description: `booking_id:${input.booking_id}`,
    note: `booking_id:${input.booking_id}`,
  };

  const res = await fetch(`${squareBase(env)}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": "2024-07-17",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Square payment link create failed: ${res.status} ${err}`);
  }
  const data = await res.json<{
    payment_link: { id: string; url: string; order_id: string };
  }>();
  return {
    id: data.payment_link.id,
    url: data.payment_link.url,
    order_id: data.payment_link.order_id,
  };
}

/**
 * Verify a Square webhook.  Square computes HMAC-SHA256 over
 *   <notification_url> + <raw_body>
 * using the webhook signature key, and sends it base64 in
 * `x-square-hmacsha256-signature`.
 */
export async function verifySquareSignature(
  env: Env,
  rawBody: string,
  notificationUrl: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader || !env.SQUARE_WEBHOOK_SIGNATURE_KEY) return false;
  const expected = await hmacSha256Base64(
    env.SQUARE_WEBHOOK_SIGNATURE_KEY,
    notificationUrl + rawBody
  );
  return timingSafeEqual(expected, signatureHeader);
}

/**
 * Handle a Square webhook event.  We watch payment.updated events and
 * promote the linked booking to 'confirmed' when payment completes.
 */
export async function handleSquareEvent(env: Env, event: any): Promise<void> {
  const type: string = event.type;
  if (type !== "payment.updated" && type !== "payment.created") return;
  const payment = event.data?.object?.payment;
  if (!payment) return;

  // Find the booking via the order/reference we stored.  We also fall
  // back to searching by note/description which we populated with
  // `booking_id:N` above.
  const orderId = payment.order_id as string | undefined;
  const note = (payment.note as string | undefined) ?? "";
  let bookingId: number | null = null;
  const m = note.match(/booking_id:(\d+)/);
  if (m) bookingId = Number(m[1]);
  if (!bookingId && orderId) {
    const row = await env.DB.prepare(
      "SELECT id FROM bookings WHERE payment_session_id = ?"
    ).bind(orderId).first<{ id: number }>();
    if (row) bookingId = row.id;
  }
  if (!bookingId) return;

  if (payment.status === "COMPLETED" || payment.status === "APPROVED") {
    await env.DB.prepare(
      `UPDATE bookings
          SET status = 'confirmed',
              payment_status = 'paid',
              payment_intent_id = ?,
              hold_expires_at = NULL,
              updated_at = datetime('now')
        WHERE id = ? AND status = 'hold'`
    ).bind(payment.id ?? null, bookingId).run();
  } else if (payment.status === "CANCELED" || payment.status === "FAILED") {
    await env.DB.prepare(
      `UPDATE bookings
          SET status = 'cancelled',
              payment_status = 'failed',
              updated_at = datetime('now')
        WHERE id = ? AND status = 'hold'`
    ).bind(bookingId).run();
  }
}
