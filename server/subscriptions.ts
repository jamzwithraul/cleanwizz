/**
 * subscriptions.ts — subscription helpers for Harriet's Spotless.
 *
 * Sprint H additions:
 *   - recordLateSkip()  — increments skipped_visits_late on a subscription
 *     when a customer skips a visit with less than 48 hours notice.
 *     Called from POST /api/me/subscription/skip-next in routes.ts.
 */

import { createClient } from "@supabase/supabase-js";

// ── Supabase client (mirrors the pattern used in routes.ts) ─────────────────
const HS_SUPABASE_URL = process.env.HS_SUPABASE_URL || "https://gjfeqnfmwbsfwnbepwvu.supabase.co";
const HS_SERVICE_KEY  = process.env.HS_SUPABASE_SERVICE_ROLE_KEY || "";

export function getHsSupa() {
  if (!HS_SERVICE_KEY) return null;
  return createClient(HS_SUPABASE_URL, HS_SERVICE_KEY);
}

// ── Constants ────────────────────────────────────────────────────────────────
/** Threshold in milliseconds under which a skip is considered "late". */
export const LATE_SKIP_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

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
