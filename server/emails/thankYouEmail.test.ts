import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  sendThankYouEmail,
  buildThankYouText,
  buildThankYouHtml,
  THANK_YOU_SUBJECT,
} from "./thankYouEmail";

function makeMockResend() {
  const send = mock.fn(async (_args: any) => ({ data: { id: "mock-id" }, error: null }));
  return {
    emails: { send } as any,
    _send: send,
  };
}

describe("sendThankYouEmail", () => {
  beforeEach(() => mock.reset());

  it("calls Resend with the correct subject, from, to, and bodies", async () => {
    const mockResend = makeMockResend();

    const result = await sendThankYouEmail(
      { resend: mockResend as any },
      { to: "client@example.com", signupId: "sig-123" },
    );

    assert.equal(result.sent, true);
    assert.equal(mockResend._send.mock.callCount(), 1);
    const args = mockResend._send.mock.calls[0].arguments[0];
    assert.equal(args.subject, THANK_YOU_SUBJECT);
    assert.equal(args.to, "client@example.com");
    assert.equal(args.from, "Harry's Potter Cleaning <noreply@harryspottercleaning.ca>");
    assert.equal(args.text, buildThankYouText());
    assert.equal(args.html, buildThankYouHtml());
  });

  it("uses overridden from address and name when provided", async () => {
    const mockResend = makeMockResend();

    await sendThankYouEmail(
      {
        resend: mockResend as any,
        fromAddress: "hello@example.ca",
        fromName: "Custom Sender",
      },
      { to: "client@example.com", signupId: "sig-123" },
    );

    const args = mockResend._send.mock.calls[0].arguments[0];
    assert.equal(args.from, "Custom Sender <hello@example.ca>");
  });

  it("skips sending and returns no_api_key when resend client is null", async () => {
    const result = await sendThankYouEmail(
      { resend: null },
      { to: "client@example.com", signupId: "sig-123" },
    );
    assert.deepEqual(result, { sent: false, skipped: "no_api_key" });
  });

  it("returns { sent: false, error } and does not throw when Resend errors", async () => {
    const failing = {
      emails: {
        send: mock.fn(async () => {
          throw new Error("resend down");
        }),
      },
    };

    const result = await sendThankYouEmail(
      { resend: failing as any },
      { to: "client@example.com", signupId: "sig-123" },
    );

    assert.equal(result.sent, false);
    assert.ok(result.error instanceof Error);
    assert.equal((result.error as Error).message, "resend down");
  });

  it("body text satisfies CASL essentials: sender name, location, unsubscribe", () => {
    const body = buildThankYouText();
    assert.match(body, /Harry's Potter Cleaning/);
    assert.match(body, /Ontario, Canada/);
    assert.match(body, /unsubscribe/i);
    assert.match(body, /STOP/);
  });

  it("html body satisfies CASL essentials: sender name, location, unsubscribe", () => {
    const html = buildThankYouHtml();
    assert.match(html, /Harry's Potter Cleaning/);
    assert.match(html, /Ontario, Canada/);
    assert.match(html, /unsubscribe/i);
    assert.match(html, /STOP/);
  });
});
