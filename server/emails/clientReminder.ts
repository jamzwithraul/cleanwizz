/**
 * Client reminder email (24-hour heads-up).
 *
 * Renders HTML + plain-text bodies for the transactional reminder sent
 * ~24 hours before each appointment. Strictly service-related — no marketing.
 * Style matches the thank-you email in server/routes.ts.
 */

export interface ClientReminderInput {
  clientFirstName?: string | null;
  contractorName: string;
  slotStartAt: string | Date;
  serviceAddress: string;
  prepInstructions?: string | null;
  logoUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  replyTo: string;
}

const REPLY_TO = "bookings@harrietscleaning.ca";
const DEFAULT_LOGO =
  "https://www.harrietscleaning.ca/harriets-logo.png";

function formatSlot(slot: string | Date): string {
  const d = slot instanceof Date ? slot : new Date(slot);
  return d.toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderClientReminder(input: ClientReminderInput): RenderedEmail {
  const greeting = input.clientFirstName?.trim()
    ? `Hi ${input.clientFirstName.trim()}`
    : "Hi there";
  const slotLabel = formatSlot(input.slotStartAt);
  const logo = input.logoUrl || DEFAULT_LOGO;
  const contractor = input.contractorName || "your cleaner";
  const address = input.serviceAddress || "";
  const prep = (input.prepInstructions || "").trim();

  const prepHtml = prep
    ? `<div style="background:#fff;border:1px solid #e5e2db;border-radius:12px;padding:16px 20px;margin:0 0 16px;">
         <p style="color:#333;font-size:14px;margin:0 0 6px;"><strong>A few prep notes ✨</strong></p>
         <p style="color:#555;font-size:14px;margin:0;white-space:pre-line;">${escapeHtml(prep)}</p>
       </div>`
    : "";

  const prepText = prep ? `\nPrep notes:\n${prep}\n` : "";

  const subject = "Reminder: your cleaning is tomorrow";

  const html = `
    <div style="font-family:'Segoe UI','Nunito',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#fdf8f0;">
      <div style="text-align:center;margin-bottom:24px;">
        <img src="${logo}" alt="Harriet's Spotless" width="80" style="border-radius:12px;" />
      </div>
      <h1 style="color:#6b1629;font-size:22px;text-align:center;margin:0 0 8px;">${escapeHtml(greeting)}! ✨</h1>
      <p style="color:#555;font-size:15px;text-align:center;margin:0 0 24px;">
        Just a quick wand-wave reminder — your Harriet's Spotless cleaning is tomorrow.
      </p>
      <div style="background:#fff;border:1px solid #e5e2db;border-radius:12px;padding:20px;margin-bottom:16px;">
        <p style="color:#333;font-size:14px;margin:0 0 8px;"><strong>Appointment details</strong></p>
        <p style="color:#555;font-size:14px;margin:0 0 4px;">📅 ${escapeHtml(slotLabel)}</p>
        <p style="color:#555;font-size:14px;margin:0 0 4px;">📍 ${escapeHtml(address)}</p>
        <p style="color:#555;font-size:14px;margin:0;">🧹 Your cleaner: <strong>${escapeHtml(contractor)}</strong></p>
      </div>
      ${prepHtml}
      <p style="color:#555;font-size:13px;text-align:center;margin:16px 0 0;">
        Need to reach us? Just reply to this email.
      </p>
      <p style="color:#999;font-size:11px;text-align:center;margin-top:24px;">
        Harriet's Spotless Cleaning Co. — Ottawa's Magical Cleaners<br/>
        bookings@harrietscleaning.ca
      </p>
    </div>`;

  const text = `${greeting},

This is a quick reminder that your Harriet's Spotless cleaning is tomorrow.

When: ${slotLabel}
Where: ${address}
Your cleaner: ${contractor}
${prepText}
Need to reach us? Just reply to this email.

— Harriet's Spotless Cleaning Co.
bookings@harrietscleaning.ca
`;

  return { subject, html, text, replyTo: REPLY_TO };
}
