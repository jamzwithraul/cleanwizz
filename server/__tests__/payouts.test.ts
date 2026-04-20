import { describe, it, expect } from "vitest";
import { buildPayoutRecord } from "../payouts";
import { getContractorPayout, totalCompanyPayout } from "../pricing";

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

describe("getContractorPayout — per-contractor SOLO rate", () => {
  it("returns $160 for Standard, $240 for Deep, $320 for Move-In/Out", () => {
    expect(getContractorPayout("standard")).toBe(160);
    expect(getContractorPayout("deep")).toBe(240);
    expect(getContractorPayout("moveout")).toBe(320);
  });

  it("defaults unknown service types to Standard", () => {
    expect(getContractorPayout("bogus")).toBe(160);
  });
});

describe("totalCompanyPayout — team jobs multiply the solo rate", () => {
  it("1 cleaner on Standard = $160", () => {
    expect(totalCompanyPayout("standard", 1)).toBe(160);
  });

  it("2 cleaners: Standard=$320, Deep=$480, Move-Out=$640", () => {
    expect(totalCompanyPayout("standard", 2)).toBe(320);
    expect(totalCompanyPayout("deep", 2)).toBe(480);
    expect(totalCompanyPayout("moveout", 2)).toBe(640);
  });

  it("3-cleaner admin override: Standard=$480, Deep=$720, Move-Out=$960", () => {
    expect(totalCompanyPayout("standard", 3)).toBe(480);
    expect(totalCompanyPayout("deep", 3)).toBe(720);
    expect(totalCompanyPayout("moveout", 3)).toBe(960);
  });

  it("clamps contractor count to [1, 3] — never pays zero, never more than 3", () => {
    expect(totalCompanyPayout("standard", 0)).toBe(160);
    expect(totalCompanyPayout("standard", -5)).toBe(160);
    expect(totalCompanyPayout("standard", 10)).toBe(480);
  });
});
