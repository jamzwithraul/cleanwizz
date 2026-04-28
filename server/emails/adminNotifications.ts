/**
 * Admin notification email helpers.
 *
 * Covers:
 *   - manual-assignment-needed (gated by ADMIN_BOOKING_NOTIFICATIONS_ENABLED)
 *   - new contractor signup
 *   - new-client first booking
 *   - repeat-client booking
 *
 * All admin notifications funnel through either `sendAdminNotification`
 * (for the gated manual-assignment flow) or the internal `send` helper
 * (for signup/booking notifications), so subject/from/gating stay consistent.
 */

import { Resend } from "resend";

// ── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_ADMIN_EMAIL = "admin@harrietscleaning.ca";
const MANUAL_ASSIGN_ADMIN_EMAIL = "magic@harrietscleaning.ca";
const DEFAULT_FROM = "Harriet's Spotless Cleaning Co. <magic@harrietscleaning.ca>";

export function getAdminEmail(): string {
  return process.env.ADMIN_NOTIFICATION_EMAIL || DEFAULT_ADMIN_EMAIL;
}

export function getFromEmail(): string {
  const addr = process.env.EMAIL_FROM_ADDRESS;
  const name = process.env.EMAIL_FROM_NAME;
  if (addr) return name ? `${name} <${addr}>` : addr;
  return process.env.FROM_EMAIL || DEFAULT_FROM;
}

// ── Manual-assignment path (gated) ───────────────────────────────────────────

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

export function adminNotificationsEnabled(): boolean {
  const raw = (process.env.ADMIN_BOOKING_NOTIFICATIONS_ENABLED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function sendAdminNotification(
  resend: AdminNotifier | Resend | null | undefined,
  rendered: AdminNotificationRenderedEmail,
): Promise<{ sent: boolean; skipped?: "disabled" | "no_client"; error?: string }> {
  if (!adminNotificationsEnabled()) return { sent: false, skipped: "disabled" };
  if (!resend) return { sent: false, skipped: "no_client" };
  try {
    await (resend as AdminNotifier).emails.send({
      from: getFromEmail(),
      to: MANUAL_ASSIGN_ADMIN_EMAIL,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    return { sent: true };
  } catch (err: any) {
    return { sent: false, error: err?.message || String(err) };
  }
}

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

// ── Signup + booking notifications (ungated) ─────────────────────────────────

let _resend: Resend | null | undefined;
function getResend(): Resend | null {
  if (_resend !== undefined) return _resend;
  _resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
  return _resend;
}

export function __setResendForTests(r: Resend | null): void {
  _resend = r;
}

function torontoTimestamp(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} America/Toronto`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(text: string): string {
  return `<pre style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1a0a0e;white-space:pre-wrap;">${escapeHtml(
    text,
  )}</pre>`;
}

async function send(opts: {
  subject: string;
  text: string;
  eventType: string;
  eventKey: string;
}): Promise<{ sent: boolean; skipped?: "no_api_key" | "error"; error?: unknown }> {
  const resend = getResend();
  if (!resend) {
    console.warn(
      `[adminNotify] RESEND_API_KEY missing — skipping ${opts.eventType} email for ${opts.eventKey}`,
    );
    return { sent: false, skipped: "no_api_key" };
  }
  try {
    await resend.emails.send({
      from: getFromEmail(),
      to: getAdminEmail(),
      subject: opts.subject,
      text: opts.text,
      html: textToHtml(opts.text),
    });
    return { sent: true };
  } catch (err) {
    console.error(
      `[adminNotify] Failed to send ${opts.eventType} email for ${opts.eventKey}:`,
      err,
    );
    return { sent: false, skipped: "error", error: err };
  }
}

export interface NewContractorInput {
  email: string;
  authUserId: string;
  timestamp?: Date;
}

export function buildNewContractorEmail(input: NewContractorInput): { subject: string; text: string } {
  const ts = torontoTimestamp(input.timestamp ?? new Date());
  return {
    subject: `New contractor signup — ${input.email}`,
    text:
      `A new contractor has signed up.\n\n` +
      `Email: ${input.email}\n` +
      `User ID: ${input.authUserId}\n` +
      `Timestamp: ${ts}\n\n` +
      `Next step: they'll complete the contractor application. You'll see them in the admin portal once they submit.\n\n` +
      `— Harriet's Spotless Cleaning Co. system`,
  };
}

export async function sendNewContractorNotification(input: NewContractorInput) {
  const { subject, text } = buildNewContractorEmail(input);
  return send({ subject, text, eventType: "contractor_signup", eventKey: input.authUserId });
}

export interface BookingNotificationInput {
  email: string;
  name: string;
  referenceCode: string;
  serviceType: string;
  total: number;
  address: string;
  appointmentStart?: string | null;
  slotCount?: number;
}

function formatAppointment(input: BookingNotificationInput): string {
  if ((input.slotCount ?? 1) > 1) return "multi-session";
  if (!input.appointmentStart) return "multi-session";
  const d = new Date(input.appointmentStart);
  if (Number.isNaN(d.getTime())) return "multi-session";
  return d.toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

export function buildNewClientBookingEmail(input: BookingNotificationInput): { subject: string; text: string } {
  return {
    subject: `New client — first booking from ${input.email}`,
    text:
      `A new client just completed their first booking.\n\n` +
      `Client email: ${input.email}\n` +
      `Client name: ${input.name}\n` +
      `Booking reference: ${input.referenceCode}\n` +
      `Service: ${input.serviceType}\n` +
      `Total: $${input.total.toFixed(2)}\n` +
      `Address: ${input.address}\n` +
      `Appointment: ${formatAppointment(input)}\n\n` +
      `— Harriet's Spotless Cleaning Co. system`,
  };
}

export async function sendNewClientBookingNotification(input: BookingNotificationInput) {
  const { subject, text } = buildNewClientBookingEmail(input);
  return send({ subject, text, eventType: "new_client_booking", eventKey: input.email });
}

export interface RepeatClientBookingInput extends BookingNotificationInput {
  totalBookings: number;
}

export function buildRepeatClientBookingEmail(input: RepeatClientBookingInput): { subject: string; text: string } {
  return {
    subject: `Repeat client booking — ${input.email} (#${input.totalBookings})`,
    text:
      `A returning client just booked again.\n\n` +
      `Client email: ${input.email}\n` +
      `Client name: ${input.name}\n` +
      `Booking reference: ${input.referenceCode}\n` +
      `Service: ${input.serviceType}\n` +
      `Total: $${input.total.toFixed(2)}\n` +
      `Address: ${input.address}\n` +
      `Appointment: ${formatAppointment(input)}\n` +
      `Total bookings by this client: ${input.totalBookings}\n\n` +
      `— Harriet's Spotless Cleaning Co. system`,
  };
}

export async function sendRepeatClientBookingNotification(input: RepeatClientBookingInput) {
  const { subject, text } = buildRepeatClientBookingEmail(input);
  return send({ subject, text, eventType: "repeat_client_booking", eventKey: input.email });
}

export function fireNewContractorNotification(input: NewContractorInput): void {
  void sendNewContractorNotification(input).catch((e) =>
    console.error("[adminNotify] unexpected error (contractor):", e),
  );
}

export function fireNewClientBookingNotification(input: BookingNotificationInput): void {
  void sendNewClientBookingNotification(input).catch((e) =>
    console.error("[adminNotify] unexpected error (new client):", e),
  );
}

export function fireRepeatClientBookingNotification(input: RepeatClientBookingInput): void {
  void sendRepeatClientBookingNotification(input).catch((e) =>
    console.error("[adminNotify] unexpected error (repeat client):", e),
  );
}
