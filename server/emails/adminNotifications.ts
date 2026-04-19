// ── Admin notification emails ────────────────────────────────────────────────
// Sent to ADMIN_NOTIFICATION_EMAIL (default admin@harryspottercleaning.ca) on
// three events: new contractor signup, new-client first booking, repeat-client
// booking. All sends are fire-and-forget — failures must never bubble up to
// the triggering operation.
//
// Uses the same Resend client / FROM_EMAIL sender as the other transactional
// emails in server/routes.ts.

import { Resend } from "resend";

const DEFAULT_ADMIN_EMAIL = "admin@harryspottercleaning.ca";
const DEFAULT_FROM = "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>";

export function getAdminEmail(): string {
  return process.env.ADMIN_NOTIFICATION_EMAIL || DEFAULT_ADMIN_EMAIL;
}

export function getFromEmail(): string {
  // Prefer EMAIL_FROM_ADDRESS + EMAIL_FROM_NAME (spec), fall back to FROM_EMAIL
  // (existing repo env var) and finally to the hardcoded verified sender.
  const addr = process.env.EMAIL_FROM_ADDRESS;
  const name = process.env.EMAIL_FROM_NAME;
  if (addr) return name ? `${name} <${addr}>` : addr;
  return process.env.FROM_EMAIL || DEFAULT_FROM;
}

let _resend: Resend | null | undefined;
function getResend(): Resend | null {
  if (_resend !== undefined) return _resend;
  _resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
  return _resend;
}

// Test-only seam: allow unit tests to inject a mock Resend instance.
export function __setResendForTests(r: Resend | null): void {
  _resend = r;
}

function torontoTimestamp(d: Date = new Date()): string {
  // Format ISO-like string in America/Toronto (approximation good enough for the
  // body of an internal notification).
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

// ── Event 1: New contractor signup ──────────────────────────────────────────
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
      `— Harry Spotter Cleaning Co. system`,
  };
}

export async function sendNewContractorNotification(input: NewContractorInput) {
  const { subject, text } = buildNewContractorEmail(input);
  return send({ subject, text, eventType: "contractor_signup", eventKey: input.authUserId });
}

// ── Events 2 & 3: Booking notifications ─────────────────────────────────────
export interface BookingNotificationInput {
  email: string;
  name: string;
  referenceCode: string;
  serviceType: string;
  total: number;
  address: string;
  /** ISO start of the (single) appointment, or null for multi-session bookings. */
  appointmentStart?: string | null;
  /** Number of slots in this booking — >1 renders as "multi-session". */
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
      `— Harry Spotter Cleaning Co. system`,
  };
}

export async function sendNewClientBookingNotification(input: BookingNotificationInput) {
  const { subject, text } = buildNewClientBookingEmail(input);
  return send({ subject, text, eventType: "new_client_booking", eventKey: input.email });
}

export interface RepeatClientBookingInput extends BookingNotificationInput {
  /** Total count of bookings for this client INCLUDING the current one. */
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
      `— Harry Spotter Cleaning Co. system`,
  };
}

export async function sendRepeatClientBookingNotification(input: RepeatClientBookingInput) {
  const { subject, text } = buildRepeatClientBookingEmail(input);
  return send({ subject, text, eventType: "repeat_client_booking", eventKey: input.email });
}

// ── Fire-and-forget wrappers ────────────────────────────────────────────────
// These never throw; they run the send in the background so callers inside a
// request handler don't block on network I/O.

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
