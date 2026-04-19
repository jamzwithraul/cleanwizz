/**
 * sendAgreementSignedConfirmation — Resend helper for the
 * "your signed contractor agreement" confirmation email.
 *
 * Attaches both the executed agreement PDF and the SignWell Certificate
 * of Completion. Harry Spotter branding to match the other transactional
 * emails sent from cleanwizz (see server/routes.ts).
 *
 * Fire-and-forget from the webhook handler — the webhook MUST return 200
 * whether or not the email delivery succeeds.
 */

import type { Resend } from "resend";

export interface AgreementSignedInput {
  to: string;
  contractorName: string;
  signedPdf: Buffer;
  certificatePdf: Buffer;
  portalUrl?: string;
  from?: string;
  logoUrl?: string;
}

export interface AgreementSignedResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_FROM =
  process.env.FROM_EMAIL ||
  "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>";

const DEFAULT_PORTAL_URL = "https://harryspottercleaning.ca/contractor";

export const AGREEMENT_SIGNED_SUBJECT =
  "Your Harry Spotter Cleaning contractor agreement — signed copy attached";

/**
 * Minimal Resend surface we rely on — makes the helper easy to mock in tests
 * without importing the full SDK type.
 */
export interface ResendLike {
  emails: {
    send: (opts: Record<string, unknown>) => Promise<unknown>;
  };
}

export async function sendAgreementSignedConfirmation(
  resend: ResendLike | Resend | null,
  input: AgreementSignedInput,
): Promise<AgreementSignedResult> {
  if (!resend) return { ok: false, error: "Resend not configured" };
  if (!input.to) return { ok: false, error: "Missing recipient" };

  const from = input.from ?? DEFAULT_FROM;
  const portal = input.portalUrl ?? DEFAULT_PORTAL_URL;
  const contractorName = input.contractorName || "Contractor";

  const text = [
    `Hi ${contractorName},`,
    "",
    "Your Harry Spotter Cleaning Co. Independent Contractor Agreement has been signed. ✨",
    "",
    "Attached to this email you'll find:",
    "  • The fully executed agreement (PDF)",
    "  • The SignWell Certificate of Completion (PDF)",
    "",
    "These are your copies for your records. You can also download them anytime from your contractor portal:",
    portal,
    "",
    "If you spot anything that doesn't look right, reply to this email and we'll sort it out.",
    "",
    "— Harry Spotter Cleaning Co.",
  ].join("\n");

  const html = buildAgreementSignedHtml({ contractorName, portal, logoUrl: input.logoUrl });

  try {
    await resend.emails.send({
      from,
      to: input.to,
      subject: AGREEMENT_SIGNED_SUBJECT,
      text,
      html,
      attachments: [
        {
          filename: "harry-spotter-contractor-agreement-signed.pdf",
          content: input.signedPdf,
        },
        {
          filename: "harry-spotter-agreement-certificate-of-completion.pdf",
          content: input.certificatePdf,
        },
      ],
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function buildAgreementSignedHtml(o: {
  contractorName: string;
  portal: string;
  logoUrl?: string;
}): string {
  const headerGrad = "linear-gradient(135deg,#6b1629 0%,#a01733 60%,#78420e 100%)";
  const logoTag = o.logoUrl
    ? `<img src="${o.logoUrl}" alt="Harry Spotter" style="width:72px;height:72px;border-radius:50%;background:#fff;padding:6px;object-fit:contain;margin:0 auto 12px;display:block;">`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f7f6f2;font-family:'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:32px auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);">
  <div style="background:${headerGrad};padding:28px 36px;text-align:center;">
    ${logoTag}
    <h1 style="color:#f9bc15;margin:0;font-size:22px;font-weight:800;">Harry Spotter Cleaning Co.</h1>
    <p style="color:rgba(249,188,21,.75);margin:4px 0 0;font-size:12px;">Contractor agreement signed</p>
  </div>
  <div style="background:#fff;padding:28px 36px;">
    <p style="font-size:16px;color:#1a0a0e;margin:0 0 16px;">Hi <strong>${o.contractorName}</strong>,</p>
    <p style="font-size:14px;color:#5a4a3a;margin:0 0 16px;line-height:1.6;">
      Your <strong>Independent Contractor Agreement</strong> has been signed. ✨ Attached to this email you'll find the fully executed PDF and the SignWell Certificate of Completion.
    </p>
    <p style="font-size:14px;color:#5a4a3a;margin:0 0 20px;line-height:1.6;">
      These are your copies for your records. You can also download them anytime from your contractor portal.
    </p>
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${o.portal}" style="display:inline-block;background:linear-gradient(135deg,#a01733,#7e162c);color:#f9bc15;text-decoration:none;padding:12px 28px;border-radius:50px;font-weight:700;font-size:14px;">Open my contractor portal</a>
    </div>
    <p style="font-size:12px;color:#7a7974;margin:0;">If you spot anything that doesn't look right, reply to this email and we'll sort it out.</p>
  </div>
  <div style="background:#1a0a0e;padding:14px 36px;text-align:center;border-top:2px solid #f9bc15;">
    <p style="color:rgba(249,188,21,.5);font-size:11px;margin:0;">Harry Spotter Cleaning Co. · harryspottercleaning.ca</p>
  </div>
</div>
</body></html>`;
}
