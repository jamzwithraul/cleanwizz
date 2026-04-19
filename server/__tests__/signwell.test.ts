import { describe, it, expect } from "vitest";
import crypto from "crypto";

import {
  buildPrefillFields,
  computeSignwellSignature,
  verifySignwellSignature,
  createAgreementDocument,
} from "../signwell";

describe("signwell signature verification", () => {
  const secret = "whsec_test_secret_123";
  const body = JSON.stringify({ event_type: "document_completed", data: { object: { id: "doc_abc" } } });

  it("accepts a valid signature", () => {
    const sig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifySignwellSignature(body, sig, secret)).toBe(true);
  });

  it("accepts a signature prefixed with sha256=", () => {
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifySignwellSignature(body, sig, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const bad = crypto.createHmac("sha256", "wrong-secret").update(body, "utf8").digest("hex");
    expect(verifySignwellSignature(body, bad, secret)).toBe(false);
  });

  it("rejects a mutated body under the original signature", () => {
    const sig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const tampered = body.replace("doc_abc", "doc_evil");
    expect(verifySignwellSignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifySignwellSignature(body, undefined, secret)).toBe(false);
    expect(verifySignwellSignature(body, "", secret)).toBe(false);
  });

  it("rejects a missing body", () => {
    const sig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifySignwellSignature(undefined, sig, secret)).toBe(false);
  });

  it("rejects when the secret is not configured", () => {
    const sig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifySignwellSignature(body, sig, undefined)).toBe(false);
    expect(verifySignwellSignature(body, sig, "")).toBe(false);
  });

  it("rejects a malformed (non-hex) signature without throwing", () => {
    expect(verifySignwellSignature(body, "not-a-hex-signature", secret)).toBe(false);
  });

  it("rejects a signature of the wrong length (truncated / expired-style)", () => {
    const good = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
    expect(verifySignwellSignature(body, good.slice(0, 32), secret)).toBe(false);
  });

  it("handles raw Buffer bodies identically to strings", () => {
    const raw = Buffer.from(body, "utf8");
    const sig = computeSignwellSignature(raw, secret);
    expect(verifySignwellSignature(raw, sig, secret)).toBe(true);
  });
});

describe("buildPrefillFields — contractor_applications → SignWell payload", () => {
  it("maps name, email, phone, and a full address into the template field keys", () => {
    const fields = buildPrefillFields({
      id: "c-1",
      full_name: "Jane Doe",
      email: "jane@example.com",
      phone: "+1-613-555-0100",
      address_line1: "123 Maple St",
      address_line2: "Apt 4",
      city: "Ottawa",
      province: "ON",
      postal_code: "K1A 0B1",
      country: "Canada",
    });
    expect(fields).toEqual({
      contractor_name: "Jane Doe",
      contractor_email: "jane@example.com",
      contractor_phone: "+1-613-555-0100",
      contractor_address: "123 Maple St, Apt 4, Ottawa, ON, K1A 0B1, Canada",
    });
  });

  it("tolerates missing optional address parts", () => {
    const fields = buildPrefillFields({
      id: "c-2",
      full_name: "John Smith",
      email: "john@example.com",
    });
    expect(fields.contractor_name).toBe("John Smith");
    expect(fields.contractor_email).toBe("john@example.com");
    expect(fields.contractor_phone).toBe("");
    expect(fields.contractor_address).toBe("");
  });

  it("trims whitespace on every field", () => {
    const fields = buildPrefillFields({
      id: "c-3",
      full_name: "  Raul Alvarado  ",
      email: "  raul@example.com  ",
      phone: "  555  ",
      address_line1: "  1 King St  ",
      city: "  Ottawa  ",
      province: "  ON  ",
      postal_code: "  K1A0B1  ",
      country: "  Canada  ",
    });
    expect(fields.contractor_name).toBe("Raul Alvarado");
    expect(fields.contractor_email).toBe("raul@example.com");
    expect(fields.contractor_phone).toBe("555");
    expect(fields.contractor_address).toBe("1 King St, Ottawa, ON, K1A0B1, Canada");
  });
});

describe("createAgreementDocument", () => {
  it("POSTs to /documents/ with X-Api-Key, template_id, recipients, and prefilled template_fields", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fakeFetch: any = async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "sw_doc_123",
          recipients: [
            { id: "contractor", embedded_signing_url: "https://signwell.test/sign/abc" },
          ],
        }),
      };
    };

    const result = await createAgreementDocument(
      { apiKey: "sk_test", templateId: "tpl_xyz", apiBase: "https://sw.test/v1", fetchImpl: fakeFetch },
      {
        id: "c-7",
        full_name: "Jane Doe",
        email: "jane@example.com",
        phone: "555",
        address_line1: "1 Main St",
        city: "Ottawa",
        province: "ON",
        postal_code: "K1A0B1",
        country: "Canada",
      },
      { redirectUrl: "https://example.test/back", testMode: true },
    );

    expect(result).toEqual({
      documentId: "sw_doc_123",
      embeddedSigningUrl: "https://signwell.test/sign/abc",
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://sw.test/v1/documents/");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["X-Api-Key"]).toBe("sk_test");

    const body = JSON.parse(calls[0].init.body);
    expect(body.template_id).toBe("tpl_xyz");
    expect(body.test_mode).toBe(true);
    expect(body.redirect_url).toBe("https://example.test/back");
    expect(body.recipients[0]).toMatchObject({
      id: "contractor",
      email: "jane@example.com",
      name: "Jane Doe",
    });
    const fieldMap = Object.fromEntries(
      body.template_fields.map((f: any) => [f.api_id, f.value]),
    );
    expect(fieldMap.contractor_name).toBe("Jane Doe");
    expect(fieldMap.contractor_email).toBe("jane@example.com");
    expect(fieldMap.contractor_address).toContain("Ottawa");
    expect(body.metadata.contractor_id).toBe("c-7");
  });

  it("throws on a non-OK response from SignWell", async () => {
    const fakeFetch: any = async () => ({
      ok: false,
      status: 400,
      text: async () => "Bad template",
      json: async () => ({}),
    });
    await expect(
      createAgreementDocument(
        { apiKey: "k", templateId: "t", fetchImpl: fakeFetch },
        { id: "c", full_name: "n", email: "e@x" },
      ),
    ).rejects.toThrow(/SignWell createDocument failed/);
  });
});
