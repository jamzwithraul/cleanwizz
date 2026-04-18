import { Resend } from "resend";

export interface ThankYouEmailDeps {
  resend: Pick<Resend, "emails"> | null;
  fromAddress?: string;
  fromName?: string;
}

export interface ThankYouEmailInput {
  to: string;
  signupId: string;
}

const DEFAULT_FROM_ADDRESS = "noreply@harryspottercleaning.ca";
const DEFAULT_FROM_NAME = "Harry's Potter Cleaning";

export const THANK_YOU_SUBJECT = "Thanks for signing up — your discount is active";

export function buildThankYouText(): string {
  return [
    "Hi there,",
    "",
    "Thanks for signing up with Harry's Potter Cleaning. Your discount is now active and will apply automatically to your current booking.",
    "",
    "If you didn't just request this, you can safely ignore this message.",
    "",
    "To unsubscribe from future promotional emails, reply STOP or click the link at the bottom of any email we send.",
    "",
    "— Harry's Potter Cleaning",
    "Ontario, Canada", // TODO: replace with actual business mailing address for CASL compliance
  ].join("\n");
}

export function buildThankYouHtml(): string {
  // Minimal one-column layout — intentionally plain for deliverability + CASL compliance.
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#222;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;max-width:560px;width:100%;border-radius:6px;overflow:hidden;">
        <tr><td style="padding:28px 32px 8px;">
          <h1 style="font-size:20px;margin:0 0 16px;color:#1a1a1a;">Thanks for signing up</h1>
          <p style="font-size:15px;line-height:1.5;margin:0 0 14px;">
            Your discount is now active and will apply automatically to your current booking with Harry's Potter Cleaning.
          </p>
          <p style="font-size:14px;line-height:1.5;margin:0 0 14px;color:#555;">
            If you didn't just request this, you can safely ignore this message.
          </p>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;border-top:1px solid #eee;font-size:12px;color:#666;line-height:1.5;">
          <p style="margin:0 0 6px;"><strong>Harry's Potter Cleaning</strong><br>Ontario, Canada</p>
          <!-- TODO: replace "Ontario, Canada" with actual business mailing address for CASL compliance -->
          <p style="margin:0;">To unsubscribe from future promotional emails, reply to this email with <strong>STOP</strong>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Send the post-signup thank-you email. Safe to call without awaiting —
 * never throws; returns a result object instead. Callers should log the result.
 */
export async function sendThankYouEmail(
  deps: ThankYouEmailDeps,
  input: ThankYouEmailInput,
): Promise<{ sent: boolean; skipped?: "no_api_key"; error?: unknown }> {
  const { resend } = deps;
  if (!resend) {
    console.warn(
      `[thank-you-email] RESEND_API_KEY not set — skipping send for signup=${input.signupId}`,
    );
    return { sent: false, skipped: "no_api_key" };
  }

  const fromAddress = deps.fromAddress ?? DEFAULT_FROM_ADDRESS;
  const fromName = deps.fromName ?? DEFAULT_FROM_NAME;

  try {
    await resend.emails.send({
      from: `${fromName} <${fromAddress}>`,
      to: input.to,
      subject: THANK_YOU_SUBJECT,
      text: buildThankYouText(),
      html: buildThankYouHtml(),
    });
    console.log(`[thank-you-email] sent signup=${input.signupId} to=${input.to}`);
    return { sent: true };
  } catch (error) {
    console.error(
      `[thank-you-email] send failed signup=${input.signupId} to=${input.to}`,
      error,
    );
    return { sent: false, error };
  }
}
