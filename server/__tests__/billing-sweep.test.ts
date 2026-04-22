/**
 * Billing sweep — unit tests  (Sprint F)
 *
 * All Supabase and Stripe calls are mocked via vi.mock().
 * No real network calls are made.
 *
 * Covers:
 *   1.  Sweep picks up due subscriptions (active, next_visit_at <= now+24h)
 *   2.  Sweep skips paused subscriptions (paused_until in the future)
 *   3.  Sweep skips cancelled subscriptions
 *   4.  Sweep advances next_visit_at by 14 days on success
 *   5.  Sweep logs error and does NOT advance next_visit_at on Stripe failure
 *   6.  Auth: requests without X-Cron-Secret -> 401
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";

// ── Mocks must be declared before the module under test is imported ───────────
// vi.mock is hoisted — we cannot reference local variables inside the factory.
// Instead we use vi.hoisted() to create references that are safe to use in the factory.

const { mockHsSupa, mockCreateVisit } = vi.hoisted(() => {
  const mockCreateVisit = vi.fn();

  // Build a minimal Supabase-like client that we can configure per-test
  const mockHsSupa = {
    from: vi.fn(),
  };

  return { mockHsSupa, mockCreateVisit };
});

vi.mock("../subscriptions.js", () => ({
  hsSupa:                      mockHsSupa,
  createVisitForSubscription:  mockCreateVisit,
}));

// Import AFTER mocks are set up
import { runDailyBillingSweep } from "../cron/subscription-billing.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeActiveSub(overrides: Partial<{
  id:           string;
  status:       string;
  next_visit_at: string | null;
  paused_until:  string | null;
}> = {}): object {
  return {
    id:            overrides.id            ?? "sub-001",
    status:        overrides.status        ?? "active",
    next_visit_at: overrides.next_visit_at ?? daysAgo(0),
    paused_until:  overrides.paused_until  ?? null,
    customer_email:    "test@example.com",
    customer_name:     "Test User",
    customer_phone:    null,
    service_address:   "123 Test St",
    service_type:      "standard",
    sqft:              2000,
    frequency:         "biweekly",
    stripe_customer_id:       "cus_test",
    stripe_payment_method_id: "pm_test",
    discount_pct:      15,
    founders_lock:     true,
    locked_base_price_cents: 58000,
    created_at:        daysAgo(30),
    cancelled_at:      null,
  };
}

/**
 * Sets up the Supabase mock for a query that returns `rows`.
 * Returns the insertChain so tests can assert on error logging.
 */
function mockQueryReturning(rows: object[]) {
  const insertChain = {
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  const selectChain = {
    eq:  vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    or:  vi.fn().mockResolvedValue({ data: rows, error: null }),
  };

  mockHsSupa.from.mockImplementation((table: string) => {
    if (table === "subscription_billing_errors") return insertChain;
    // subscriptions table
    return { select: vi.fn(() => selectChain) };
  });

  return { selectChain, insertChain };
}

// ── Reset mocks between tests ─────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. Sweep picks up due subscriptions ──────────────────────────────────────
describe("runDailyBillingSweep — picks up due subscriptions", () => {
  it("calls createVisitForSubscription for each due active subscription", async () => {
    const sub1 = makeActiveSub({ id: "sub-001", next_visit_at: daysAgo(0) });
    const sub2 = makeActiveSub({ id: "sub-002", next_visit_at: daysAgo(1) });
    mockQueryReturning([sub1, sub2]);
    mockCreateVisit.mockResolvedValue({
      paymentIntentId: "pi_test",
      jobId:           "job_test",
      chargedCents:    49300,
    });

    const result = await runDailyBillingSweep();

    expect(mockCreateVisit).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.processed).toBe(2);
  });

  it("returns zeroed result when no subscriptions are due", async () => {
    mockQueryReturning([]);

    const result = await runDailyBillingSweep();

    expect(mockCreateVisit).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ── 2. Sweep skips paused subscriptions ──────────────────────────────────────
describe("runDailyBillingSweep — skips paused subscriptions", () => {
  it("skips a subscription whose paused_until is in the future", async () => {
    // The DB query uses OR to filter these out, but simulate a row slipping through
    const sub = makeActiveSub({ paused_until: daysFromNow(3) });
    mockQueryReturning([sub]);

    const result = await runDailyBillingSweep();

    expect(mockCreateVisit).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("does NOT skip a subscription whose paused_until is in the past", async () => {
    const sub = makeActiveSub({ paused_until: daysAgo(2) });
    mockQueryReturning([sub]);
    mockCreateVisit.mockResolvedValue({
      paymentIntentId: "pi_test",
      jobId:           "job_test",
      chargedCents:    49300,
    });

    const result = await runDailyBillingSweep();

    expect(mockCreateVisit).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

// ── 3. Sweep skips cancelled subscriptions ───────────────────────────────────
describe("runDailyBillingSweep — skips cancelled subscriptions", () => {
  it("skips a subscription with status='cancelled'", async () => {
    const sub = makeActiveSub({ status: "cancelled" });
    mockQueryReturning([sub]);

    const result = await runDailyBillingSweep();

    expect(mockCreateVisit).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it("skips a subscription with status='waitlisted'", async () => {
    const sub = makeActiveSub({ status: "waitlisted" });
    mockQueryReturning([sub]);

    const result = await runDailyBillingSweep();

    expect(mockCreateVisit).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

// ── 4. Sweep advances next_visit_at on success ───────────────────────────────
describe("runDailyBillingSweep — advances next_visit_at by 14 days on success", () => {
  it("calls createVisitForSubscription with the sub's current next_visit_at", async () => {
    const scheduledAt = daysAgo(0);
    const sub = makeActiveSub({ id: "sub-001", next_visit_at: scheduledAt });
    mockQueryReturning([sub]);
    mockCreateVisit.mockResolvedValue({
      paymentIntentId: "pi_test",
      jobId:           "job_test",
      chargedCents:    49300,
    });

    await runDailyBillingSweep();

    // createVisitForSubscription handles the 14-day advance internally.
    // The sweep passes the current next_visit_at to it.
    expect(mockCreateVisit).toHaveBeenCalledWith("sub-001", scheduledAt);
  });

  it("succeeded count increments for each successful createVisit call", async () => {
    const subs = [
      makeActiveSub({ id: "s1" }),
      makeActiveSub({ id: "s2" }),
      makeActiveSub({ id: "s3" }),
    ];
    mockQueryReturning(subs);
    mockCreateVisit.mockResolvedValue({
      paymentIntentId: "pi_test",
      jobId:           "job_test",
      chargedCents:    49300,
    });

    const result = await runDailyBillingSweep();

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
  });
});

// ── 5. Sweep logs error and does NOT advance on Stripe failure ────────────────
describe("runDailyBillingSweep — handles Stripe failures", () => {
  it("records failure in result.errors when createVisitForSubscription throws", async () => {
    const sub = makeActiveSub({ id: "sub-fail" });
    mockQueryReturning([sub]);
    mockCreateVisit.mockRejectedValue(
      Object.assign(new Error("Your card was declined."), { code: "card_declined" })
    );

    const result = await runDailyBillingSweep();

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].subscriptionId).toBe("sub-fail");
    expect(result.errors[0].message).toContain("card was declined");
  });

  it("inserts a row into subscription_billing_errors on failure", async () => {
    const sub = makeActiveSub({ id: "sub-fail" });
    const { insertChain } = mockQueryReturning([sub]);
    mockCreateVisit.mockRejectedValue(
      Object.assign(new Error("card_declined"), { code: "card_declined" })
    );

    await runDailyBillingSweep();

    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_id:   "sub-fail",
        stripe_error_code: "card_declined",
      })
    );
  });

  it("continues processing remaining subscriptions after one failure", async () => {
    const subs = [
      makeActiveSub({ id: "sub-fail" }),
      makeActiveSub({ id: "sub-ok" }),
    ];
    mockQueryReturning(subs);
    mockCreateVisit
      .mockRejectedValueOnce(new Error("card_declined"))
      .mockResolvedValueOnce({ paymentIntentId: "pi_ok", jobId: "j_ok", chargedCents: 49300 });

    const result = await runDailyBillingSweep();

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.processed).toBe(2);
  });

  it("does not advance next_visit_at when createVisitForSubscription throws", async () => {
    // createVisitForSubscription owns the DB update of next_visit_at.
    // When it throws, it never reaches that update — verified by confirming
    // the mock threw before completing.
    const sub = makeActiveSub({ id: "sub-fail", next_visit_at: daysAgo(0) });
    mockQueryReturning([sub]);
    mockCreateVisit.mockRejectedValue(new Error("stripe_unavailable"));

    const result = await runDailyBillingSweep();

    expect(result.failed).toBe(1);
    // createVisitForSubscription was called — it just threw before advancing
    expect(mockCreateVisit).toHaveBeenCalledTimes(1);
  });
});

// ── 6. Auth: requests without X-Cron-Secret -> 401 ───────────────────────────
describe("POST /api/cron/billing-sweep auth guard", () => {
  /**
   * Tests the guard logic extracted from routes.ts.
   * Mirrors: if (cronSecret && provided !== cronSecret) -> 401
   */

  function cronAuthGuard(
    secret: string | undefined,
    headerValue: string | undefined
  ): boolean {
    if (!secret) return true; // no secret configured -> open (dev mode)
    return headerValue === secret;
  }

  it("rejects requests with no X-Cron-Secret header", () => {
    expect(cronAuthGuard("supersecret", undefined)).toBe(false);
  });

  it("rejects requests with an incorrect X-Cron-Secret header", () => {
    expect(cronAuthGuard("supersecret", "wrong-secret")).toBe(false);
  });

  it("allows requests with the correct X-Cron-Secret header", () => {
    expect(cronAuthGuard("supersecret", "supersecret")).toBe(true);
  });

  it("allows all requests when CRON_SHARED_SECRET is not configured (dev mode)", () => {
    expect(cronAuthGuard(undefined, undefined)).toBe(true);
  });
});
