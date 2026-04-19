import { describe, it, expect } from "vitest";
import { buildPayoutRecord } from "../payouts";

describe("buildPayoutRecord", () => {
  const base = {
    jobId: "job-123",
    contractorId: "ctr-456",
    amount: 120.5,
    now: "2026-04-18T18:00:00.000Z",
  };

  it("writes a 'sent' row with the Stripe transfer id as reference", () => {
    const row = buildPayoutRecord({
      ...base,
      transferId: "tr_ABC123",
      error: null,
    });
    expect(row).toEqual({
      job_id: "job-123",
      contractor_id: "ctr-456",
      amount: 120.5,
      status: "sent",
      triggered_at: base.now,
      completed_at: base.now,
      reference: "tr_ABC123",
    });
  });

  it("writes a 'failed' row with a truncated error reference", () => {
    const longError = "x".repeat(500);
    const row = buildPayoutRecord({
      ...base,
      transferId: null,
      error: longError,
    });
    expect(row.status).toBe("failed");
    expect(row.completed_at).toBeUndefined();
    expect(row.reference?.startsWith("ERR:")).toBe(true);
    // ERR: prefix + up to 180 chars of error
    expect(row.reference!.length).toBeLessThanOrEqual(4 + 180);
  });

  it("never marks a payout 'sent' without a transfer id", () => {
    const row = buildPayoutRecord({
      ...base,
      transferId: null,
      error: "balance too low",
    });
    expect(row.status).toBe("failed");
    expect(row.reference).toBe("ERR:balance too low");
  });

  it("preserves a null reference when there's no transfer and no error text", () => {
    const row = buildPayoutRecord({
      ...base,
      transferId: null,
      error: null,
    });
    expect(row.status).toBe("failed");
    expect(row.reference).toBeNull();
  });
});
