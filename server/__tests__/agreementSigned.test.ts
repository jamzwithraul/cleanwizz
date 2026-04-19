import { describe, it, expect, vi } from "vitest";

import {
  sendAgreementSignedConfirmation,
  AGREEMENT_SIGNED_SUBJECT,
} from "../emails/agreementSigned";

describe("sendAgreementSignedConfirmation", () => {
  it("sends a Resend email with both PDFs attached and the spec-mandated subject", async () => {
    const send = vi.fn(async () => ({ id: "re_1" }));
    const resend = { emails: { send } };
    const res = await sendAgreementSignedConfirmation(resend, {
      to: "jane@example.com",
      contractorName: "Jane Doe",
      signedPdf: Buffer.from("pdf-agreement"),
      certificatePdf: Buffer.from("pdf-cert"),
    });
    expect(res.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const args = send.mock.calls[0][0] as any;
    expect(args.to).toBe("jane@example.com");
    expect(args.subject).toBe(AGREEMENT_SIGNED_SUBJECT);
    expect(args.text).toContain("Jane Doe");
    expect(args.text).toContain("signed");
    expect(args.attachments).toHaveLength(2);
    const names = args.attachments.map((a: any) => a.filename);
    expect(names.some((n: string) => /agreement.*signed/.test(n))).toBe(true);
    expect(names.some((n: string) => /certificate/.test(n))).toBe(true);
  });

  it("returns a non-ok result (and does not throw) when Resend is null", async () => {
    const res = await sendAgreementSignedConfirmation(null, {
      to: "x@y",
      contractorName: "X",
      signedPdf: Buffer.from(""),
      certificatePdf: Buffer.from(""),
    });
    expect(res.ok).toBe(false);
  });

  it("returns a non-ok result on recipient missing", async () => {
    const send = vi.fn();
    const res = await sendAgreementSignedConfirmation(
      { emails: { send } },
      {
        to: "",
        contractorName: "X",
        signedPdf: Buffer.from(""),
        certificatePdf: Buffer.from(""),
      },
    );
    expect(res.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("captures Resend errors into the result rather than throwing", async () => {
    const send = vi.fn(async () => {
      throw new Error("resend-boom");
    });
    const res = await sendAgreementSignedConfirmation(
      { emails: { send } },
      {
        to: "a@b",
        contractorName: "A",
        signedPdf: Buffer.from("x"),
        certificatePdf: Buffer.from("y"),
      },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("resend-boom");
  });
});
