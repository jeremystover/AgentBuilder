// Stripe Checkout integration.
//
// We use a Checkout Session (hosted payment page), which handles card
// entry, 3DS, Apple/Google Pay and Link for us without needing PCI
// scope on the Worker.  The flow is:
//
//   1. Public booking page POSTs /api/public/checkout with
//      { provider: 'stripe', unit_id, start_date, end_date, guest }.
//   2. The Worker creates a 'hold' booking row, then creates a Stripe
//      Checkout Session with metadata.booking_id = <that row>.
//   3. Guest pays at checkout.stripe.com.
//   4. Stripe posts checkout.session.completed to /api/webhooks/stripe.
//   5. The webhook verifies the signature, looks up the booking via
//      payment_session_id, and flips status='hold' -> 'confirmed'.
//
// Intentionally no Stripe SDK - it depends on Node APIs that don't
// exist in the Workers runtime. We just hit the REST API with fetch.

import type { Env, Booking } from "../types";
import { hmacSha256Hex, timingSafeEqual } from "../hmac";

const STRIPE_API = "https://api.stripe.com/v1";

export interface StripeCheckoutInput {
  booking_id: number;
  amount_cents: number;
  currency: string;
  description: string;
  guest_email?: string;
  success_url: string;
  cancel_url: string;
}

/** Stripe wants form-encoded bodies with [bracketed] keys for nested data. */
function encodeForm(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) usp.append(k, String(v));
  }
  return usp.toString();
}

export async function createStripeCheckoutSession(
  env: Env,
  input: StripeCheckoutInput
): Promise<{ id: string; url: string }> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not configured");

  const form = encodeForm({
    mode: "payment",
    success_url: input.success_url,
    cancel_url: input.cancel_url,
    "payment_method_types[0]": "card",
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": input.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": input.amount_cents,
    "line_items[0][price_data][product_data][name]": input.description,
    "metadata[booking_id]": input.booking_id,
    customer_email: input.guest_email,
    // When a session times out we'll get checkout.session.expired and
    // the webhook will cancel the hold.
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe checkout create failed: ${res.status} ${err}`);
  }
  const data = await res.json<{ id: string; url: string }>();
  return { id: data.id, url: data.url };
}

/**
 * Verify a Stripe webhook signature.
 * Stripe sends a `stripe-signature: t=TS,v1=SIG[,v1=...]` header.
 * signed_payload = `${TS}.${rawBody}` and SIG is HMAC_SHA256 hex.
 * A 5 minute tolerance prevents replay attacks.
 */
export async function verifyStripeSignature(
  env: Env,
  rawBody: string,
  header: string | null,
  toleranceSec = 300
): Promise<boolean> {
  if (!header || !env.STRIPE_WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(header.split(",").map(p => {
    const [k, ...rest] = p.split("=");
    return [k.trim(), rest.join("=").trim()];
  }));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const signedPayload = `${t}.${rawBody}`;
  const expected = await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET, signedPayload);
  if (!timingSafeEqual(expected, v1)) return false;
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  return ageSec <= toleranceSec;
}

/**
 * Apply a Stripe webhook event to our DB.  We only care about
 * checkout.session.completed and checkout.session.expired.
 */
export async function handleStripeEvent(env: Env, event: any): Promise<void> {
  const type: string = event.type;
  const session = event.data?.object;
  if (!session) return;
  const bookingId = Number(session.metadata?.booking_id);
  if (!bookingId) return;

  if (type === "checkout.session.completed" && session.payment_status === "paid") {
    await env.DB.prepare(
      `UPDATE bookings
          SET status = 'confirmed',
              payment_status = 'paid',
              payment_intent_id = ?,
              hold_expires_at = NULL,
              updated_at = datetime('now')
        WHERE id = ? AND status = 'hold'`
    ).bind(session.payment_intent ?? null, bookingId).run();
    return;
  }

  if (type === "checkout.session.expired" || type === "checkout.session.async_payment_failed") {
    await env.DB.prepare(
      `UPDATE bookings
          SET status = 'cancelled',
              payment_status = 'failed',
              updated_at = datetime('now')
        WHERE id = ? AND status = 'hold'`
    ).bind(bookingId).run();
    return;
  }
}
