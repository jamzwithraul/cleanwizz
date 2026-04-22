/**
 * subscriptions.ts — subscription helpers for Harriet's Spotless.
 *
 * Sprint D scope:
 *   - createVisitForSubscription()  — exported helper, called manually via admin endpoint
 *   - Full cron automation is deferred to Sprint F
 *   - Customer portal is deferred to Sprint E
 *
 * Sprint H additions:
 *   - recordLateSkip()  — increments skipped_visits_late on a subscription
 *     when a customer skips a visit with less than 48 hours notice.
 *     Called from POST /api/me/subscription/skip-next in routes.ts.
 */

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// ── Clients (re-use env vars already set up in routes.ts) ────────────────────
const HS_SUPABASE_URL = process.env.HS_SUPABASE_URL || "https://gjfeqnfmwbsfwnbepwvu.supabase.co";
const HS_SERVICE_KEY  = process.env.HS_SUPABASE_SERVICE_ROLE_KEY || "";
export const hsSupa   = HS_SERVICE_KEY
  ? createClient(HS_SUPABASE_URL, HS_SERVICE_KEY)
  : null;

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

export function getHsSupa() {
  if (!HS_SERVICE_KEY) return null;
  return createClient(HS_SUPABASE_URL, HS_SERVICE_KEY);
}

// ── Constants ────────────────────────────────────────────────────────────────
export const SUBSCRIPTION_SEAT_CAP = 15;

/** Threshold in milliseconds under which a skip is considered "late". */
export const LATE_SKIP_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

// ── Types ────────────────────────────────────────────────────────────────────
export interface Subscription {
  id: string;
  customer_email: string;
  customer_name: string;
  customer_phone: string | null;
  service_address: string;
  service_type: string;
  sqft: number;
  frequency: string;
  status: "active" | "paused" | "cancelled" | "waitlisted";
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  discount_pct: number;
  founders_lock: boolean;
  locked_base_price_cents: number;
  next_visit_at: string | null;
  paused_until: string | null;
  created_at: string;
  cancelled_at: string | null;
}

// ── Seat helpers ─────────────────────────────────────────────────────────────

/** Returns { active, waitlisted } counts from the subscriptions table. */
export async function getSubscriptionCounts(): Promise<{ active: number; waitlisted: number }> {
  if (!hsSupa) return { active: 0, waitlisted: 0 };

  const { count: active } = await hsSupa
    .from("subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("status", "active");

  const { count: waitlisted } = await hsSupa
    .from("subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("status", "waitlisted");

  return { active: active ?? 0, waitlisted: waitlisted ?? 0 };
}

// ── Pricing helper ────────────────────────────────────────────────────────────

/**
 * Applies the subscription discount to a locked base price.
 * discountPct is stored as e.g. 15.00 → multiplier = (1 - 15/100) = 0.85.
 * Returns the discounted amount in cents (rounded to whole cents).
 */
export function applySubscriptionDiscount(lockedBasePriceCents: number, discountPct: number): number {
  const multiplier = 1 - discountPct / 100;
  return Math.round(lockedBasePriceCents * multiplier);
}

// ── Per-visit billing scaffold ────────────────────────────────────────────────

/**
 * Creates a `jobs` row for the next subscription visit and fires an
 * off-session Stripe PaymentIntent for the discounted amount.
 *
 * Sprint D: exported for manual invocation via the admin endpoint.
 * Sprint F will wire this into a daily cron.
 *
 * @returns The Stripe PaymentIntent id and the jobs row id.
 */
export async function createVisitForSubscription(
  subscriptionId: string,
  scheduledAt: string,
): Promise<{ paymentIntentId: string; jobId: string; chargedCents: number }> {
  if (!hsSupa) throw new Error("Supabase client not initialised (missing HS_SUPABASE_SERVICE_ROLE_KEY).");
  if (!stripe) throw new Error("Stripe client not initialised (missing STRIPE_SECRET_KEY).");

  // 1. Load subscription
  const { data: sub, error: subErr } = await hsSupa
    .from("subscriptions")
    .select("*")
    .eq("id", subscriptionId)
    .single();

  if (subErr || !sub) throw new Error(`Subscription ${subscriptionId} not found.`);
  if (sub.status !== "active") throw new Error(`Subscription ${subscriptionId} is not active (status: ${sub.status}).`);
  if (!sub.stripe_payment_method_id) throw new Error("Subscription has no saved payment method.");
  if (!sub.stripe_customer_id) throw new Error("Subscription has no Stripe customer.");

  // 2. Compute discounted charge amount
  const chargedCents = applySubscriptionDiscount(sub.locked_base_price_cents, sub.discount_pct);

  // 3. Create jobs row (status: pending)
  const { data: job, error: jobErr } = await hsSupa
    .from("jobs")
    .insert({
      subscription_id: subscriptionId,
      client_name:     sub.customer_name,
      client_email:    sub.customer_email,
      client_phone:    sub.customer_phone,
      address:         sub.service_address,
      service_type:    sub.service_type,
      sqft:            sub.sqft,
      scheduled_at:    scheduledAt,
      status:          "pending",
      amount_cents:    chargedCents,
      source:          "subscription",
    })
    .select("id")
    .single();

  if (jobErr || !job) {
    throw new Error(`Failed to create job row: ${jobErr?.message ?? "unknown error"}`);
  }

  // 4. Create off-session Stripe PaymentIntent
  const intent = await stripe.paymentIntents.create({
    amount:               chargedCents,
    currency:             "cad",
    customer:             sub.stripe_customer_id,
    payment_method:       sub.stripe_payment_method_id,
    off_session:          true,
    confirm:              true,
    description:          `Harriet's Spotless — subscription visit (${sub.service_type}, ${sub.sqft} sqft) — ${scheduledAt.slice(0, 10)}`,
    metadata: {
      subscription_id:  subscriptionId,
      job_id:           job.id,
      customer_email:   sub.customer_email,
    },
  });

  // 5. Update job row with payment intent id
  await hsSupa
    .from("jobs")
    .update({ payment_intent_id: intent.id, status: "confirmed" })
    .eq("id", job.id);

  // 6. Advance next_visit_at by 14 days
  const nextVisit = new Date(scheduledAt);
  nextVisit.setDate(nextVisit.getDate() + 14);
  await hsSupa
    .from("subscriptions")
    .update({ next_visit_at: nextVisit.toISOString() })
    .eq("id", subscriptionId);

  return {
    paymentIntentId: intent.id,
    jobId:           job.id,
    chargedCents,
  };
}

/**
 * recordLateSkip — increments the skipped_visits_late counter on a
 * subscription row.  Used for pattern detection and admin review; does NOT
 * auto-charge the 50% fee in this sprint.
 *
 * @param subscriptionId  The UUID of the subscription row in Supabase.
 * @param _supaOverride   Optional Supabase client override (for testing only).
 * @returns               The updated skipped_visits_late count, or null on error.
 */
export async function recordLateSkip(
  subscriptionId: string,
  _supaOverride?: ReturnType<typeof getHsSupa>,
): Promise<number | null> {
  const supa = _supaOverride !== undefined ? _supaOverride : getHsSupa();
  if (!supa) {
    console.warn("[subscriptions] recordLateSkip: Supabase client unavailable — skipping counter update");
    return null;
  }

  // Fetch current counter
  const { data: sub, error: fetchErr } = await supa
    .from("subscriptions")
    .select("skipped_visits_late")
    .eq("id", subscriptionId)
    .single();

  if (fetchErr || !sub) {
    console.error("[subscriptions] recordLateSkip: fetch error", fetchErr?.message);
    return null;
  }

  const newCount = (sub.skipped_visits_late ?? 0) + 1;

  const { error: updateErr } = await supa
    .from("subscriptions")
    .update({ skipped_visits_late: newCount })
    .eq("id", subscriptionId);

  if (updateErr) {
    console.error("[subscriptions] recordLateSkip: update error", updateErr.message);
    return null;
  }

  return newCount;
}
