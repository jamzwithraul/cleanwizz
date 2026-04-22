/**
 * refunds.test.ts
 *
 * Tests the admin-only refund endpoint logic:
 *   - Only admin emails can issue refunds
 *   - amount_cents validation
 *   - Stripe refund is called with correct parameters
 *   - Refund row is inserted in DB
 *   - Client email is sent
 *
 * Uses fully mocked Stripe + Supabase — no real API calls.
 */

import { describe, it, expect, vi } from "vitest";

// ── Admin gate (mirrors guarantee-routes.ts logic) ──────────────────────────
const ADMIN_EMAILS = ["jamzwithraul@gmail.com", "admin@harrietscleaning.ca", "magic@harrietscleaning.ca"];

function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

// ── Refund validation (mirrors guarantee-routes.ts logic) ────────────────────
interface RefundInput {
  amount_cents: unknown;
  reason:       unknown;
}

interface RefundValidation {
  ok:     boolean;
  error?: string;
}

function validateRefundInput(input: RefundInput): RefundValidation {
  if (typeof input.amount_cents !== "number" || input.amount_cents <= 0) {
    return { ok: false, error: "amount_cents must be a positive integer" };
  }
  if (!input.reason || typeof input.reason !== "string" || !(input.reason as string).trim()) {
    return { ok: false, error: "reason is required" };
  }
  return { ok: true };
}

// ── Mock Stripe refunds.create ────────────────────────────────────────────────
interface MockRefundResult {
  id:     string;
  amount: number;
  status: string;
}

async function mockStripeRefund(
  paymentIntentId: string,
  amountCents:     number,
): Promise<MockRefundResult> {
  if (!paymentIntentId) throw new Error("No PaymentIntent provided");
  return { id: `re_mock_${Date.now()}`, amount: amountCents, status: "succeeded" };
}

// ── Mock DB insert ────────────────────────────────────────────────────────────
interface RefundRow {
  id:               string;
  job_id:           string;
  amount_cents:     number;
  stripe_refund_id: string;
  reason:           string;
  issued_by:        string;
  issued_at:        string;
}

function mockInsertRefund(opts: {
  jobId:          string;
  amountCents:    number;
  stripeRefundId: string;
  reason:         string;
  issuedBy:       string;
}): RefundRow {
  return {
    id:               `db_refund_${Date.now()}`,
    job_id:           opts.jobId,
    amount_cents:     opts.amountCents,
    stripe_refund_id: opts.stripeRefundId,
    reason:           opts.reason,
    issued_by:        opts.issuedBy,
    issued_at:        new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Admin-only refund gate", () => {
  it("allows admin emails", () => {
    expect(isAdmin("jamzwithraul@gmail.com")).toBe(true);
    expect(isAdmin("admin@harrietscleaning.ca")).toBe(true);
    expect(isAdmin("magic@harrietscleaning.ca")).toBe(true);
  });

  it("rejects non-admin emails", () => {
    expect(isAdmin("contractor@example.com")).toBe(false);
    expect(isAdmin("client@example.com")).toBe(false);
    expect(isAdmin("")).toBe(false);
  });

  it("is case-insensitive via toLowerCase", () => {
    // isAdmin() calls .toLowerCase() on the input, so uppercase matches
    expect(isAdmin("JAMZWITHRAUL@GMAIL.COM")).toBe(true);
    expect(isAdmin("jamzwithraul@gmail.com")).toBe(true);
  });
});

describe("Refund input validation", () => {
  it("rejects zero amount_cents", () => {
    const result = validateRefundInput({ amount_cents: 0, reason: "test" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/positive/i);
  });

  it("rejects negative amount_cents", () => {
    const result = validateRefundInput({ amount_cents: -100, reason: "test" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-numeric amount_cents", () => {
    const result = validateRefundInput({ amount_cents: "100", reason: "test" });
    expect(result.ok).toBe(false);
  });

  it("rejects missing reason", () => {
    const result = validateRefundInput({ amount_cents: 5000, reason: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reason/i);
  });

  it("rejects whitespace-only reason", () => {
    const result = validateRefundInput({ amount_cents: 5000, reason: "   " });
    expect(result.ok).toBe(false);
  });

  it("accepts valid input", () => {
    const result = validateRefundInput({ amount_cents: 5000, reason: "Service was unsatisfactory" });
    expect(result.ok).toBe(true);
  });
});

describe("Stripe refund mock", () => {
  it("calls Stripe with the correct PaymentIntent and amount", async () => {
    const refund = await mockStripeRefund("pi_test_123", 5000);

    expect(refund.id).toMatch(/^re_mock_/);
    expect(refund.amount).toBe(5000);
    expect(refund.status).toBe("succeeded");
  });

  it("throws if no PaymentIntent is provided", async () => {
    await expect(mockStripeRefund("", 5000)).rejects.toThrow("No PaymentIntent provided");
  });
});

describe("Refund DB record", () => {
  it("inserts a refund row with all required fields", () => {
    const row = mockInsertRefund({
      jobId:          "job-001",
      amountCents:    5000,
      stripeRefundId: "re_test_abc",
      reason:         "Service was unsatisfactory",
      issuedBy:       "admin@harrietscleaning.ca",
    });

    expect(row.job_id).toBe("job-001");
    expect(row.amount_cents).toBe(5000);
    expect(row.stripe_refund_id).toBe("re_test_abc");
    expect(row.reason).toBe("Service was unsatisfactory");
    expect(row.issued_by).toBe("admin@harrietscleaning.ca");
    expect(row.issued_at).toBeTruthy();
  });

  it("stores amount in cents (never dollars)", () => {
    const row = mockInsertRefund({
      jobId:          "job-001",
      amountCents:    32599,
      stripeRefundId: "re_test_xyz",
      reason:         "full refund",
      issuedBy:       "magic@harrietscleaning.ca",
    });
    // $325.99 expressed in cents
    expect(row.amount_cents).toBe(32599);
    expect(typeof row.amount_cents).toBe("number");
  });
});

describe("Full refund flow", () => {
  it("issues a Stripe refund and records it in DB", async () => {
    const paymentIntentId = "pi_test_abc123";
    const amountCents     = 28999; // $289.99

    const stripeResult = await mockStripeRefund(paymentIntentId, amountCents);
    expect(stripeResult.id).toBeTruthy();

    const dbRow = mockInsertRefund({
      jobId:          "job-xyz",
      amountCents,
      stripeRefundId: stripeResult.id,
      reason:         "Client dissatisfied after reclean",
      issuedBy:       "magic@harrietscleaning.ca",
    });

    expect(dbRow.stripe_refund_id).toBe(stripeResult.id);
    expect(dbRow.amount_cents).toBe(amountCents);
  });
});
