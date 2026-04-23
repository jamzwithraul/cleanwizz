/**
 * Client reminder update email — sent when a confirmed appointment's
 * contractor (or other key detail) changes after the initial reminder.
 */

import type { ClientReminderInput, RenderedEmail } from "./clientReminder";

const REPLY_TO = "admin@harryspottercleaning.ca";
const DEFAULT_LOGO =
  "https://harryspottercleaning.ca/Completed_Trasp_Logo_for_Harry_Spotter.png";

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

export function renderClientReminderUpdate(input: ClientReminderInput): RenderedEmail {
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
         <p style="color:#333;font-size:14px;margin:0 0 6px;"><strong>A few prep notes</strong></p>
         <p style="color:#555;font-size:14px;margin:0;white-space:pre-line;">${escapeHtml(prep)}</p>
       </div>`
    : "";

  const prepText = prep ? `\nPrep notes:\n${prep}\n` : "";

  const subject = "Update: your cleaning appointment details changed";

  const html = `
    <div style="font-family:'Segoe UI','Nunito',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#fdf8f0;">
      <div style="text-align:center;margin-bottom:24px;">
        <img src="${logo}" alt="Harry Spotter" width="80" style="border-radius:12px;" />
      </div>
      <h1 style="color:#6b1629;font-size:22px;text-align:center;margin:0 0 8px;">${escapeHtml(greeting)},</h1>
      <p style="color:#555;font-size:15px;text-align:center;margin:0 0 24px;">
        Your cleaner has been updated. New details below.
      </p>
      <div style="background:#fff;border:1px solid #e5e2db;border-radius:12px;padding:20px;margin-bottom:16px;">
        <p style="color:#333;font-size:14px;margin:0 0 8px;"><strong>Updated appointment details</strong></p>
        <p style="color:#555;font-size:14px;margin:0 0 4px;">📅 ${escapeHtml(slotLabel)}</p>
        <p style="color:#555;font-size:14px;margin:0 0 4px;">📍 ${escapeHtml(address)}</p>
        <p style="color:#555;font-size:14px;margin:0;">🧹 Your cleaner: <strong>${escapeHtml(contractor)}</strong></p>
      </div>
      ${prepHtml}
      <p style="color:#555;font-size:13px;text-align:center;margin:16px 0 0;">
        Questions? Just reply to this email and we'll sort it.
      </p>
      <p style="color:#999;font-size:11px;text-align:center;margin-top:24px;">
        Harry Spotter Cleaning Co. — Ottawa's Magical Cleaners<br/>
        admin@harryspottercleaning.ca
      </p>
    </div>`;

  const text = `${greeting},

Your cleaner has been updated. New details below.

When: ${slotLabel}
Where: ${address}
Your cleaner: ${contractor}
${prepText}
Questions? Just reply to this email and we'll sort it.

— Harry Spotter Cleaning Co.
admin@harryspottercleaning.ca
`;

  return { subject, html, text, replyTo: REPLY_TO };
}
