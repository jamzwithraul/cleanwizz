/**
 * SignWell API client + webhook signature verification.
 *
 * SignWell uses:
 *   - Bearer / X-Api-Key authentication (we use X-Api-Key header per current docs).
 *   - Webhook signatures via HMAC-SHA256 of the raw request body with
 *     SIGNWELL_WEBHOOK_SECRET, compared in constant time against the
 *     `X-Signwell-Signature` header.
 *
 * See spec: signwell-contractor-agreement-spec.md
 */

import crypto from "crypto";

const API_BASE = process.env.SIGNWELL_API_BASE || "https://www.signwell.com/api/v1";

export interface ContractorPrefill {
  id: string;
  full_name: string;
  email: string;
  phone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  province?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

/**
 * Flatten a contractor row into the fields pre-filled on the SignWell template.
 * Returned keys match the template's API identifiers — exported separately so
 * the unit test can assert mapping without spinning up HTTP.
 */
export function buildPrefillFields(c: ContractorPrefill): Record<string, string> {
  const trim = (s: string | null | undefined) => (s ?? "").trim();
  const city = trim(c.city);
  const province = trim(c.province);
  const cityProv = [city, province].filter(Boolean).join(", ");
  const addressParts = [
    trim(c.address_line1),
    trim(c.address_line2),
    cityProv,
    trim(c.postal_code),
    trim(c.country),
  ].filter(Boolean);
  return {
    contractor_name: trim(c.full_name),
    contractor_email: trim(c.email),
    contractor_phone: trim(c.phone),
    contractor_address: addressParts.join(", "),
  };
}

export interface CreateDocumentResult {
  documentId: string;
  embeddedSigningUrl: string | null;
}

export interface SignWellConfig {
  apiKey: string;
  templateId: string;
  apiBase?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Create a document from the contractor-agreement template, pre-filling
 * contractor profile fields and returning the embedded signing URL.
 *
 * Safe to call only behind the /api/agreement/start endpoint — consumes a
 * document slot in the SignWell account.
 */
export async function createAgreementDocument(
  cfg: SignWellConfig,
  contractor: ContractorPrefill,
  opts: { redirectUrl?: string; testMode?: boolean } = {},
): Promise<CreateDocumentResult> {
  const fields = buildPrefillFields(contractor);
  const body = {
    template_id: cfg.templateId,
    test_mode: opts.testMode ?? (process.env.NODE_ENV !== "production"),
    embedded_signing: true,
    name: `Harry Spotter — Independent Contractor Agreement — ${contractor.full_name}`,
    subject: "Please sign: Harry Spotter Independent Contractor Agreement",
    message:
      "Review and sign your Harry Spotter Cleaning Co. Independent Contractor Agreement. " +
      "After signing, a copy will be emailed to you and stored in your contractor portal.",
    redirect_url: opts.redirectUrl,
    recipients: [
      {
        id: "contractor",
        placeholder_name: "Contractor",
        name: contractor.full_name,
        email: contractor.email,
      },
    ],
    template_fields: Object.entries(fields).map(([api_id, value]) => ({
      api_id,
      value,
    })),
    metadata: {
      contractor_id: contractor.id,
      source: "harryspottercleaning_onboarding",
    },
  };

  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.apiBase ?? API_BASE}/documents/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": cfg.apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SignWell createDocument failed: ${res.status} ${text}`);
  }
  const data: any = await res.json();
  const contractorRecipient = (data?.recipients ?? []).find(
    (r: any) => r.id === "contractor" || r.placeholder_name === "Contractor",
  );
  const embeddedSigningUrl: string | null =
    contractorRecipient?.embedded_signing_url ??
    data?.embedded_signing_url ??
    null;
  const documentId: string | undefined = data?.id ?? data?.document_id;
  if (!documentId) {
    throw new Error("SignWell createDocument: response missing document id");
  }
  return { documentId, embeddedSigningUrl };
}

export async function downloadSignedPdf(
  cfg: SignWellConfig,
  documentId: string,
): Promise<Buffer> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.apiBase ?? API_BASE}/documents/${encodeURIComponent(documentId)}/completed_pdf/`;
  const res = await doFetch(url, {
    method: "GET",
    headers: { "X-Api-Key": cfg.apiKey },
  });
  if (!res.ok) {
    throw new Error(`SignWell downloadSignedPdf failed: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function downloadCertificate(
  cfg: SignWellConfig,
  documentId: string,
): Promise<Buffer> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.apiBase ?? API_BASE}/documents/${encodeURIComponent(documentId)}/audit_trail/`;
  const res = await doFetch(url, {
    method: "GET",
    headers: { "X-Api-Key": cfg.apiKey },
  });
  if (!res.ok) {
    throw new Error(`SignWell downloadCertificate failed: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ── Webhook signature verification ───────────────────────────────────────────

/**
 * Compute the expected HMAC-SHA256 hex digest for a raw request body.
 * Exported for tests.
 */
export function computeSignwellSignature(rawBody: string | Buffer, secret: string): string {
  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Constant-time compare of the signature header against the expected digest.
 * Returns false for any missing input or length mismatch rather than throwing,
 * so callers can always 401 on a false return.
 */
export function verifySignwellSignature(
  rawBody: string | Buffer | undefined,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!rawBody || !signatureHeader || !secret) return false;
  // Some providers prefix the signature with "sha256=". Accept either form.
  const headerValue = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  let expected: string;
  try {
    expected = computeSignwellSignature(rawBody, secret);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(headerValue, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
