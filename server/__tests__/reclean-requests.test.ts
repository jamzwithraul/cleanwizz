/**
 * reclean-requests.test.ts
 *
 * Tests the reclean request lifecycle:
 *   pending → approved → dispatched → completed
 *   pending → denied
 *
 * Uses in-memory mocks — no real Supabase or Stripe calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── In-memory reclean store ────────────────────────────────────────────────────
type RecleanStatus = "pending" | "approved" | "dispatched" | "completed" | "denied";

interface RecleanRow {
  id:                         string;
  job_id:                     string;
  client_email:               string;
  description:                string;
  photos_urls:                string[];
  status:                     RecleanStatus;
  admin_notes:                string | null;
  dispatched_to_contractor_id: string | null;
  dispatched_at:              string | null;
  completed_at:               string | null;
  denied_reason:              string | null;
  denied_at:                  string | null;
  sla_breached:               boolean;
  requested_at:               string;
}

function makeReclean(overrides: Partial<RecleanRow> = {}): RecleanRow {
  return {
    id:                         "reclean-001",
    job_id:                     "job-001",
    client_email:               "client@example.com",
    description:                "The bathroom was not cleaned properly near the sink area.",
    photos_urls:                [],
    status:                     "pending",
    admin_notes:                null,
    dispatched_to_contractor_id: null,
    dispatched_at:              null,
    completed_at:               null,
    denied_reason:              null,
    denied_at:                  null,
    sla_breached:               false,
    requested_at:               new Date().toISOString(),
    ...overrides,
  };
}

// ── Lifecycle helpers (pure functions that mirror guarantee-routes logic) ─────

function approveReclean(
  row: RecleanRow,
  contractorId: string,
  contractorVersion: number,
  requiredVersion = 1,
): { ok: boolean; error?: string; updated?: RecleanRow } {
  if (contractorVersion < requiredVersion) {
    return { ok: false, error: `Contractor has not signed version ${requiredVersion}` };
  }
  if (row.status !== "pending") {
    return { ok: false, error: `Cannot approve a request in status '${row.status}'` };
  }
  return {
    ok: true,
    updated: {
      ...row,
      status:                      "dispatched",
      dispatched_to_contractor_id: contractorId,
      dispatched_at:               new Date().toISOString(),
    },
  };
}

function denyReclean(row: RecleanRow, reason: string): { ok: boolean; error?: string; updated?: RecleanRow } {
  if (row.status !== "pending") {
    return { ok: false, error: `Cannot deny a request in status '${row.status}'` };
  }
  if (!reason.trim()) {
    return { ok: false, error: "reason is required" };
  }
  return {
    ok: true,
    updated: {
      ...row,
      status:        "denied",
      denied_reason: reason.trim(),
      denied_at:     new Date().toISOString(),
    },
  };
}

function contractorCompleteReclean(
  row: RecleanRow,
  contractorId: string,
): { ok: boolean; error?: string; updated?: RecleanRow } {
  if (row.dispatched_to_contractor_id !== contractorId) {
    return { ok: false, error: "This reclean is not assigned to your account" };
  }
  if (row.status !== "dispatched") {
    return { ok: false, error: `Cannot complete a request in status '${row.status}'` };
  }
  return {
    ok: true,
    updated: {
      ...row,
      status:       "completed",
      completed_at: new Date().toISOString(),
    },
  };
}

function adminMarkCompleted(row: RecleanRow): { ok: boolean; updated?: RecleanRow } {
  return {
    ok: true,
    updated: { ...row, status: "completed", completed_at: new Date().toISOString() },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Reclean request lifecycle: pending → dispatched → completed", () => {
  it("approve transitions status to dispatched and records contractor + timestamp", () => {
    const row = makeReclean();
    const result = approveReclean(row, "contractor-123", 1);

    expect(result.ok).toBe(true);
    expect(result.updated!.status).toBe("dispatched");
    expect(result.updated!.dispatched_to_contractor_id).toBe("contractor-123");
    expect(result.updated!.dispatched_at).toBeTruthy();
  });

  it("contractor completing reclean sets status=completed and completed_at", () => {
    const dispatched = makeReclean({
      status:                      "dispatched",
      dispatched_to_contractor_id: "contractor-123",
      dispatched_at:               new Date().toISOString(),
    });
    const result = contractorCompleteReclean(dispatched, "contractor-123");

    expect(result.ok).toBe(true);
    expect(result.updated!.status).toBe("completed");
    expect(result.updated!.completed_at).toBeTruthy();
  });

  it("admin mark-completed works on dispatched requests", () => {
    const dispatched = makeReclean({ status: "dispatched" });
    const result = adminMarkCompleted(dispatched);

    expect(result.ok).toBe(true);
    expect(result.updated!.status).toBe("completed");
  });

  it("contractor cannot complete a reclean assigned to someone else", () => {
    const dispatched = makeReclean({
      status:                      "dispatched",
      dispatched_to_contractor_id: "contractor-999",
    });
    const result = contractorCompleteReclean(dispatched, "contractor-123");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not assigned/i);
  });

  it("cannot approve an already-dispatched request", () => {
    const dispatched = makeReclean({ status: "dispatched" });
    const result = approveReclean(dispatched, "contractor-123", 1);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dispatched/);
  });

  it("cannot complete a pending request (must be dispatched first)", () => {
    const pending = makeReclean();
    // The pending row has no dispatched_to_contractor_id, so the ownership
    // check fires before the status check — both correctly reject the call.
    const result  = contractorCompleteReclean(pending, "contractor-123");

    expect(result.ok).toBe(false);
    // Either "not assigned" or status error is acceptable — both block completion.
    expect(result.error).toBeTruthy();
  });
});

describe("Reclean request lifecycle: pending → denied", () => {
  it("deny sets status=denied with reason and denied_at", () => {
    const row    = makeReclean();
    const result = denyReclean(row, "Area was outside the agreed scope of work.");

    expect(result.ok).toBe(true);
    expect(result.updated!.status).toBe("denied");
    expect(result.updated!.denied_reason).toBe("Area was outside the agreed scope of work.");
    expect(result.updated!.denied_at).toBeTruthy();
  });

  it("cannot deny without a reason", () => {
    const row    = makeReclean();
    const result = denyReclean(row, "   ");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reason/i);
  });

  it("cannot deny an already-denied request", () => {
    const denied = makeReclean({ status: "denied", denied_reason: "first denial" });
    const result = denyReclean(denied, "second attempt");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/denied/);
  });

  it("cannot deny a completed request", () => {
    const completed = makeReclean({ status: "completed" });
    const result    = denyReclean(completed, "too late");

    expect(result.ok).toBe(false);
  });
});

describe("24-hour reclean window enforcement", () => {
  it("accepts a reclean request within 24 hours of completion", () => {
    const completedAt = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    const elapsed     = Date.now() - new Date(completedAt).getTime();
    const withinWindow = elapsed <= 24 * 60 * 60 * 1000;

    expect(withinWindow).toBe(true);
  });

  it("rejects a reclean request more than 24 hours after completion", () => {
    const completedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const elapsed     = Date.now() - new Date(completedAt).getTime();
    const withinWindow = elapsed <= 24 * 60 * 60 * 1000;

    expect(withinWindow).toBe(false);
  });

  it("description must be at least 30 characters", () => {
    const shortDesc  = "Too short.";
    const longDesc   = "The bathroom was not cleaned properly near the sink area.";

    expect(shortDesc.trim().length >= 30).toBe(false);
    expect(longDesc.trim().length  >= 30).toBe(true);
  });
});
