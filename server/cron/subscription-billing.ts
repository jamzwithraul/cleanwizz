/**
 * Subscription billing sweep — Sprint F
 *
 * runDailyBillingSweep():
 *   - Finds active subscriptions whose next_visit_at is within the next 24 hours
 *     and are not currently paused.
 *   - Calls createVisitForSubscription() for each — this creates a jobs row and
 *     fires an off-session Stripe PaymentIntent.
 *   - On success: advances next_visit_at by 14 days.
 *   - On failure: logs to subscription_billing_errors and leaves next_visit_at
 *     unchanged so the next sweep retries.
 *
 * The sweep is intentionally idempotent with respect to next_visit_at: once
 * createVisitForSubscription() advances the date, the subscription falls out of
 * the "due" window and won't be picked up again until the next cycle.
 *
 * Triggering:
 *   POST /api/cron/billing-sweep  (protected by X-Cron-Secret header)
 *   See routes.ts for the HTTP wrapper.
 */

import { hsSupa, createVisitForSubscription } from "../subscriptions.js";
import type { Subscription } from "../subscriptions.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SweepResult {
  processed:  number;
  succeeded:  number;
  failed:     number;
  skipped:    number;
  errors:     Array<{ subscriptionId: string; message: string }>;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Runs the daily billing sweep.
 * Safe to call multiple times; already-advanced subscriptions won't re-fire.
 */
export async function runDailyBillingSweep(): Promise<SweepResult> {
  if (!hsSupa) {
    throw new Error("Supabase client not initialised (missing HS_SUPABASE_SERVICE_ROLE_KEY).");
  }

  const result: SweepResult = {
    processed: 0,
    succeeded: 0,
    failed:    0,
    skipped:   0,
    errors:    [],
  };

  // ── 1. Query due subscriptions ────────────────────────────────────────────
  // "Due" = active, next_visit_at is within the next 24 hours, and not paused.
  const lookAheadAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const now         = new Date().toISOString();

  const { data: dueSubs, error: queryErr } = await hsSupa
    .from("subscriptions")
    .select("*")
    .eq("status", "active")
    .lte("next_visit_at", lookAheadAt)
    .not("next_visit_at", "is", null)
    .or(`paused_until.is.null,paused_until.lt.${now}`);

  if (queryErr) {
    throw new Error(`Billing sweep query failed: ${queryErr.message}`);
  }

  if (!dueSubs || dueSubs.length === 0) {
    return result;
  }

  // ── 2. Process each subscription ─────────────────────────────────────────
  for (const sub of dueSubs as Subscription[]) {
    result.processed++;

    // Skip if status isn't active (belt-and-suspenders — query should have filtered already)
    if (sub.status !== "active") {
      result.skipped++;
      continue;
    }

    // Skip if paused_until is in the future
    if (sub.paused_until && new Date(sub.paused_until) > new Date()) {
      result.skipped++;
      continue;
    }

    if (!sub.next_visit_at) {
      result.skipped++;
      continue;
    }

    try {
      await createVisitForSubscription(sub.id, sub.next_visit_at);
      result.succeeded++;
    } catch (err: any) {
      result.failed++;
      result.errors.push({ subscriptionId: sub.id, message: err.message ?? "Unknown error" });

      // Log to subscription_billing_errors for operator visibility
      await logBillingError(sub.id, err).catch((logErr) => {
        // Don't throw — error logging is best-effort
        console.error(`[billing-sweep] Failed to log error for sub ${sub.id}:`, logErr.message);
      });

      console.error(`[billing-sweep] Failed to process subscription ${sub.id}:`, err.message);
    }
  }

  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function logBillingError(subscriptionId: string, err: any): Promise<void> {
  if (!hsSupa) return;

  // Extract Stripe error code if present (Stripe SDK errors have a `code` property)
  const stripeErrorCode: string | null =
    err?.code ?? err?.raw?.code ?? null;

  await hsSupa.from("subscription_billing_errors").insert({
    subscription_id:   subscriptionId,
    error_message:     String(err?.message ?? err ?? "Unknown error"),
    stripe_error_code: stripeErrorCode,
  });
}
