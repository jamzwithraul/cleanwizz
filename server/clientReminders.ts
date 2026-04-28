/**
 * Internal endpoints for sending the 24h client reminder emails.
 *
 * Flow:
 *   1. Validate `X-Internal-Secret` header (guard).
 *   2. Fetch job + customer + contractor from Harriet's Spotless Supabase.
 *   3. Set `jobs.reminder_sent_at = NOW()` BEFORE the Resend call (idempotency).
 *   4. Insert into `sent_client_reminders` with ON CONFLICT DO NOTHING.
 *      - If no new row was inserted, the reminder was already delivered —
 *        respond 200 `{ sent: false, reason: "already_sent" }` and return.
 *   5. Render & send email. Resend failures do NOT reset `reminder_sent_at`
 *      (we surface the error to the caller for retry/alerting instead).
 */

import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { renderClientReminder } from "./emails/clientReminder";
import { renderClientReminderUpdate } from "./emails/clientReminderUpdate";
import type { RenderedEmail } from "./emails/clientReminder";

export type ReminderType = "initial" | "update";

export interface ResendLike {
  emails: {
    send: (args: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text?: string;
      reply_to?: string;
      replyTo?: string;
    }) => Promise<unknown>;
  };
}

export interface SendClientReminderDeps {
  supabase: SupabaseClient | null;
  resend: ResendLike | null;
  internalSecret: string;
  fromEmail?: string;
  now?: () => Date;
}

export interface SendResult {
  status: number;
  body: Record<string, unknown>;
}

function fromAddress(deps: SendClientReminderDeps): string {
  return (
    deps.fromEmail ||
    process.env.FROM_EMAIL ||
    "Harriet's Spotless Cleaning Co. <bookings@harrietscleaning.ca>"
  );
}

function guardSecret(req: Request, secret: string): SendResult | null {
  const provided = (req.headers["x-internal-secret"] as string | undefined) || "";
  if (!secret || !provided || provided !== secret) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  return null;
}

async function loadJobContext(
  supabase: SupabaseClient,
  jobId: string,
): Promise<
  | {
      job: {
        id: string;
        slot_start_at: string;
        service_address: string;
        prep_instructions: string | null;
        customer_id: string | null;
        contractor_id: string | null;
      };
      customer: { first_name: string | null; email: string } | null;
      contractor: { full_name: string | null } | null;
    }
  | { error: string }
> {
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select(
      "id, slot_start_at, service_address, prep_instructions, customer_id, contractor_id",
    )
    .eq("id", jobId)
    .single();
  if (jobErr || !job) return { error: "Job not found" };

  let customer: { first_name: string | null; email: string } | null = null;
  if (job.customer_id) {
    const { data: c } = await supabase
      .from("customers")
      .select("first_name, email")
      .eq("id", job.customer_id)
      .single();
    customer = c || null;
  }

  let contractor: { full_name: string | null } | null = null;
  if (job.contractor_id) {
    const { data: k } = await supabase
      .from("contractor_applications")
      .select("full_name")
      .eq("id", job.contractor_id)
      .single();
    contractor = k || null;
  }

  return { job, customer, contractor };
}

async function claimReminderSlot(
  supabase: SupabaseClient,
  jobId: string,
  reminderType: ReminderType,
  nowIso: string,
): Promise<{ firstTime: boolean; error?: string }> {
  // 1) Stamp jobs.reminder_sent_at BEFORE sending. This is the primary
  //    idempotency fence — cron retries observe a non-null value and skip.
  //    For 'update' we still want a fresh stamp so future cron passes don't
  //    double-send; writing NOW() is always safe.
  const { error: updErr } = await supabase
    .from("jobs")
    .update({ reminder_sent_at: nowIso })
    .eq("id", jobId);
  if (updErr) return { firstTime: false, error: updErr.message };

  // 2) Try to claim a ledger row. Duplicate (job_id, reminder_type) pairs
  //    are blocked by the unique constraint on sent_client_reminders —
  //    translate the constraint error into firstTime=false.
  const { error: insErr } = await supabase
    .from("sent_client_reminders")
    .insert({ job_id: jobId, reminder_type: reminderType });
  if (insErr) {
    const msg = (insErr.message || "").toLowerCase();
    if (msg.includes("duplicate") || msg.includes("unique") || (insErr as any).code === "23505") {
      return { firstTime: false };
    }
    return { firstTime: false, error: insErr.message };
  }
  return { firstTime: true };
}

async function handleSend(
  req: Request,
  deps: SendClientReminderDeps,
  reminderType: ReminderType,
  renderer: (input: any) => RenderedEmail,
): Promise<SendResult> {
  const gate = guardSecret(req, deps.internalSecret);
  if (gate) return gate;

  const jobId: string | undefined = req.body?.job_id;
  if (!jobId || typeof jobId !== "string") {
    return { status: 400, body: { error: "job_id is required" } };
  }

  if (!deps.supabase) return { status: 500, body: { error: "Supabase not configured" } };

  const ctx = await loadJobContext(deps.supabase, jobId);
  if ("error" in ctx) return { status: 404, body: { error: ctx.error } };

  if (!ctx.customer?.email) {
    return { status: 422, body: { error: "Customer email missing" } };
  }

  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
  const claim = await claimReminderSlot(deps.supabase, jobId, reminderType, nowIso);
  if (claim.error) return { status: 500, body: { error: claim.error } };
  if (!claim.firstTime) {
    return { status: 200, body: { sent: false, reason: "already_sent" } };
  }

  if (!deps.resend) {
    return { status: 500, body: { error: "Resend not configured" } };
  }

  const rendered = renderer({
    clientFirstName: ctx.customer.first_name,
    contractorName: ctx.contractor?.full_name || "your cleaner",
    slotStartAt: ctx.job.slot_start_at,
    serviceAddress: ctx.job.service_address,
    prepInstructions: ctx.job.prep_instructions,
  });

  try {
    await deps.resend.emails.send({
      from: fromAddress(deps),
      to: ctx.customer.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      reply_to: rendered.replyTo,
      replyTo: rendered.replyTo,
    });
  } catch (err: any) {
    // Note: reminder_sent_at and the ledger row remain set. The caller
    // should retry out-of-band; the ledger prevents duplicate sends once
    // one eventually succeeds on the Resend side.
    return {
      status: 502,
      body: {
        sent: false,
        reason: "resend_failed",
        error: err?.message || String(err),
      },
    };
  }

  return { status: 200, body: { sent: true, reminder_type: reminderType } };
}

export async function sendClientReminder(
  req: Request,
  deps: SendClientReminderDeps,
): Promise<SendResult> {
  return handleSend(req, deps, "initial", renderClientReminder);
}

export async function sendClientReminderUpdate(
  req: Request,
  deps: SendClientReminderDeps,
): Promise<SendResult> {
  return handleSend(req, deps, "update", renderClientReminderUpdate);
}

export function attachReminderEndpoints(
  app: { post: (path: string, handler: (req: Request, res: Response) => Promise<void>) => void },
  depsFactory: () => SendClientReminderDeps,
) {
  app.post("/api/internal/send-client-reminder", async (req, res) => {
    const result = await sendClientReminder(req, depsFactory());
    res.status(result.status).json(result.body);
  });
  app.post("/api/internal/send-client-reminder-update", async (req, res) => {
    const result = await sendClientReminderUpdate(req, depsFactory());
    res.status(result.status).json(result.body);
  });
}
