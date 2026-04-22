/**
 * guarantee-sla.ts — SLA breach sweep for reclean requests.
 *
 * Sprint I — Part 7.
 *
 * runSlaBreachSweep() is called by POST /api/cron/sla-sweep (protected by
 * X-Cron-Secret).  The schedule is wired externally (cron job, Render cron,
 * etc.) — this module only implements the logic.
 *
 * SLA rules:
 *   Dispatch SLA  : pending request older than 4 hours  → sla_breached = true
 *   Completion SLA: dispatched request older than 48 hours with no completed_at
 *                   → sla_breached = true
 */

import { createClient } from "@supabase/supabase-js";

const HS_SUPABASE_URL = process.env.HS_SUPABASE_URL || "https://gjfeqnfmwbsfwnbepwvu.supabase.co";
const HS_SERVICE_KEY  = process.env.HS_SUPABASE_SERVICE_ROLE_KEY || "";

function getSupa() {
  if (!HS_SERVICE_KEY) return null;
  return createClient(HS_SUPABASE_URL, HS_SERVICE_KEY);
}

export interface SlaBreachResult {
  dispatchBreaches:    number;
  completionBreaches:  number;
  totalBreached:       number;
}

/**
 * Mark reclean_requests rows as sla_breached=true where:
 *   - status='pending'    AND requested_at < now() - 4 hours   (dispatch SLA)
 *   - status='dispatched' AND dispatched_at < now() - 48 hours
 *                         AND completed_at IS NULL              (completion SLA)
 *
 * Idempotent — re-running does not double-count already-breached rows.
 */
export async function runSlaBreachSweep(): Promise<SlaBreachResult> {
  const supa = getSupa();
  if (!supa) {
    console.warn("[sla-sweep] Supabase not configured — skipping sweep");
    return { dispatchBreaches: 0, completionBreaches: 0, totalBreached: 0 };
  }

  const now = new Date();

  // ── Dispatch SLA: pending > 4 hours ────────────────────────────────────────
  const dispatchCutoff = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
  const { data: dispatchRows, error: dErr } = await supa
    .from("reclean_requests")
    .update({ sla_breached: true })
    .eq("status", "pending")
    .eq("sla_breached", false)
    .lt("requested_at", dispatchCutoff)
    .select("id");

  if (dErr) {
    console.error("[sla-sweep] Dispatch breach update error:", dErr.message);
  }
  const dispatchBreaches = dispatchRows?.length ?? 0;

  // ── Completion SLA: dispatched > 48 hours, not completed ──────────────────
  const completionCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const { data: completionRows, error: cErr } = await supa
    .from("reclean_requests")
    .update({ sla_breached: true })
    .eq("status", "dispatched")
    .eq("sla_breached", false)
    .is("completed_at", null)
    .lt("dispatched_at", completionCutoff)
    .select("id");

  if (cErr) {
    console.error("[sla-sweep] Completion breach update error:", cErr.message);
  }
  const completionBreaches = completionRows?.length ?? 0;

  const totalBreached = dispatchBreaches + completionBreaches;
  console.log(
    `[sla-sweep] Sweep complete — dispatch_breaches=${dispatchBreaches} completion_breaches=${completionBreaches} total=${totalBreached}`,
  );

  return { dispatchBreaches, completionBreaches, totalBreached };
}
