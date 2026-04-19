/**
 * Admin notification email helpers.
 *
 * Gated by `ADMIN_BOOKING_NOTIFICATIONS_ENABLED` env flag (truthy = on).
 * All admin notifications funnel through `sendAdminNotification` so that
 * subject, from-address, and gating logic stay consistent.
 */

import type { Resend } from "resend";

export interface AdminNotificationRenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface AdminNotifier {
  emails: {
    send: (args: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text?: string;
    }) => Promise<unknown>;
  };
}

const ADMIN_EMAIL = "magic@harryspottercleaning.ca";

export function adminNotificationsEnabled(): boolean {
  const raw = (process.env.ADMIN_BOOKING_NOTIFICATIONS_ENABLED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function fromAddress(): string {
  return (
    process.env.FROM_EMAIL ||
    "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>"
  );
}

export async function sendAdminNotification(
  resend: AdminNotifier | Resend | null | undefined,
  rendered: AdminNotificationRenderedEmail,
): Promise<{ sent: boolean; skipped?: "disabled" | "no_client"; error?: string }> {
  if (!adminNotificationsEnabled()) return { sent: false, skipped: "disabled" };
  if (!resend) return { sent: false, skipped: "no_client" };
  try {
    await (resend as AdminNotifier).emails.send({
      from: fromAddress(),
      to: ADMIN_EMAIL,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    return { sent: true };
  } catch (err: any) {
    return { sent: false, error: err?.message || String(err) };
  }
}

// ── Manual-assignment-needed notification ─────────────────────────────────────
export interface ManualAssignmentJob {
  id: string;
  slot_start_at?: string | Date | null;
  service_address?: string | null;
  client_name?: string | null;
  client_email?: string | null;
  pets_in_home?: boolean | null;
  reason?: string | null;
}

export function renderManualAssignmentNeededNotification(
  job: ManualAssignmentJob,
): AdminNotificationRenderedEmail {
  const jobId = job.id;
  const shortId = jobId.length > 8 ? jobId.slice(0, 8) : jobId;
  const slotLabel = job.slot_start_at
    ? new Date(job.slot_start_at as any).toLocaleString("en-CA", {
        timeZone: "America/Toronto",
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : "unscheduled";
  const reason =
    job.reason ||
    (job.pets_in_home === true
      ? "No compatible contractor (pets-in-home job with no allergy-free, pet-comfortable contractor available)"
      : "No compatible contractor available");

  const subject = `⚠️ Manual assignment needed — Job ${shortId}`;

  const html = `<div style="font-family:sans-serif;padding:24px;max-width:600px;">
      <h2 style="color:#a01733;margin:0 0 8px;">Manual assignment needed</h2>
      <p style="color:#555;font-size:14px;margin:0 0 16px;">
        A job couldn't be auto-matched to a contractor. Please assign one manually in the admin dashboard.
      </p>
      <div style="background:#fff;border:1px solid #e5e2db;border-radius:8px;padding:16px;">
        <p style="margin:0 0 6px;"><strong>Job ID:</strong> ${jobId}</p>
        <p style="margin:0 0 6px;"><strong>When:</strong> ${slotLabel}</p>
        <p style="margin:0 0 6px;"><strong>Where:</strong> ${job.service_address || "N/A"}</p>
        <p style="margin:0 0 6px;"><strong>Client:</strong> ${job.client_name || "N/A"}${job.client_email ? ` (${job.client_email})` : ""}</p>
        <p style="margin:0 0 6px;"><strong>Pets in home:</strong> ${job.pets_in_home === true ? "Yes" : job.pets_in_home === false ? "No" : "Unsure"}</p>
        <p style="margin:0;"><strong>Reason:</strong> ${reason}</p>
      </div>
    </div>`;

  const text = `Manual assignment needed

Job ID: ${jobId}
When: ${slotLabel}
Where: ${job.service_address || "N/A"}
Client: ${job.client_name || "N/A"}${job.client_email ? ` (${job.client_email})` : ""}
Pets in home: ${job.pets_in_home === true ? "Yes" : job.pets_in_home === false ? "No" : "Unsure"}
Reason: ${reason}
`;

  return { subject, html, text };
}

export async function sendManualAssignmentNeededNotification(
  resend: AdminNotifier | Resend | null | undefined,
  job: ManualAssignmentJob,
) {
  const rendered = renderManualAssignmentNeededNotification(job);
  return sendAdminNotification(resend, rendered);
}
