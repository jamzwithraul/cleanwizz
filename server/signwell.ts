/**
 * signwell.ts — SignWell API helpers for Harriet's Spotless Cleaning Co.
 *
 * Sprint I additions:
 *   - RECLEAN_CLAUSE_VERSION constant (bump when clause text changes)
 *   - getSignwellTemplateId()  — resolves template ID from env
 *   - sendContractorAgreement() — creates a document from the template and
 *     fires the signing email to the contractor
 *   - resendContractorAgreement() — used by admin "Request re-sign" button
 *
 * The SignWell template is managed in the SignWell dashboard.  The template ID
 * is stored in SIGNWELL_TEMPLATE_ID.  When a new clause is appended (as in
 * this sprint), the template in the dashboard is updated and
 * RECLEAN_CLAUSE_VERSION is bumped here — that is the single source of truth.
 */

const SIGNWELL_API_KEY = process.env.SIGNWELL_API_KEY || "";
const SIGNWELL_BASE    = "https://www.signwell.com/api/v1";

/** Current reclean clause schema version.  Bump when the template changes. */
export const RECLEAN_CLAUSE_VERSION = 1;

/**
 * Text of Section X to append to the contractor agreement template.
 * This is the canonical, authoritative copy.  The SignWell template in the
 * dashboard must include this section verbatim.
 */
export const RECLEAN_CLAUSE_TEXT = `Section X — Quality Guarantee Recleans

The Company offers a 200% satisfaction guarantee to all clients. As part of your contractor agreement, you agree that:

1. If a client submits a valid reclean request within 24 hours of a job you performed, you will return within 48 business hours to re-clean the specific areas identified, at no additional charge to the client.

2. You will not be paid an additional contractor fee for the reclean visit — the original payout already covers this obligation.

3. If you are unable to return within 48 business hours for legitimate reasons (illness, prior commitment), you will notify the Company within 4 hours so another contractor can be assigned. The Company reserves the right to deduct 25% of the original job payout in this situation to cover the replacement contractor's fee.

4. If you refuse to perform a reclean without legitimate reason, the Company may withhold the original job payout and terminate this agreement.

5. Reclean requests will be reviewed by the Company before being dispatched to you. Clients cannot request unlimited recleans — only one reclean per job is covered.

6. If the reclean is dispatched and you complete it successfully, the client's reclean obligation is fulfilled. Any subsequent refund is solely at the Company's discretion and does not affect your payout.`;

function signwellHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Api-Key":    SIGNWELL_API_KEY,
  };
}

export function getSignwellTemplateId(): string {
  return process.env.SIGNWELL_TEMPLATE_ID || "";
}

/**
 * Send (or re-send) a contractor agreement signing request.
 *
 * If contractorName / contractorEmail are provided, a new SignWell document
 * is created from the template and the signing email is dispatched.
 *
 * Returns the SignWell document id so it can be stored on the contractor row.
 */
export async function sendContractorAgreement(opts: {
  contractorId:    string;
  contractorName:  string;
  contractorEmail: string;
  isResend?:       boolean;
}): Promise<{ documentId: string; signingUrl: string | null }> {
  if (!SIGNWELL_API_KEY) {
    throw new Error("SIGNWELL_API_KEY is not configured");
  }
  const templateId = getSignwellTemplateId();
  if (!templateId) {
    throw new Error("SIGNWELL_TEMPLATE_ID is not configured");
  }

  const payload = {
    template_id: templateId,
    test_mode:   process.env.NODE_ENV !== "production",
    name:        `Contractor Agreement v${RECLEAN_CLAUSE_VERSION} — ${opts.contractorName}`,
    message:     opts.isResend
      ? "We have updated our contractor agreement to include the Quality Guarantee Reclean clause (Section X). Please review and re-sign to continue receiving job assignments."
      : "Welcome to Harriet's Spotless Cleaning Co. Please review and sign your contractor agreement to begin receiving job assignments.",
    signers: [
      {
        id:    "1",
        name:  opts.contractorName,
        email: opts.contractorEmail,
      },
    ],
    custom_requester_name:  "Harriet's Spotless Cleaning Co.",
    custom_requester_email: process.env.FROM_EMAIL_PLAIN || "magic@harrietscleaning.ca",
    metadata: {
      contractor_id:    opts.contractorId,
      clause_version:   String(RECLEAN_CLAUSE_VERSION),
    },
  };

  const res = await fetch(`${SIGNWELL_BASE}/documents/templates/`, {
    method:  "POST",
    headers: signwellHeaders(),
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SignWell API error ${res.status}: ${body}`);
  }

  const data: any = await res.json();
  const documentId  = data.id as string;
  const signerData  = (data.signers as any[])?.[0];
  const signingUrl: string | null = signerData?.signing_url ?? null;

  return { documentId, signingUrl };
}

/**
 * Retrieve a SignWell document by id (for polling status).
 */
export async function getSignwellDocument(documentId: string): Promise<any> {
  if (!SIGNWELL_API_KEY) throw new Error("SIGNWELL_API_KEY not configured");

  const res = await fetch(`${SIGNWELL_BASE}/documents/${documentId}/`, {
    headers: signwellHeaders(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SignWell API error ${res.status}: ${body}`);
  }
  return res.json();
}
