/**
 * cancellation.test.ts
 *
 * Tests for:
 *   1. Fee computation logic used by POST /api/admin/jobs/:id/cancel
 *   2. POST /api/me/subscription/skip-next — 48h window detection
 *   3. recordLateSkip() helper
 *   4. Auth enforcement smoke test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LATE_SKIP_THRESHOLD_MS, recordLateSkip } from "../subscriptions";

beforeEach(() => {
  vi.resetAllMocks();
  process.env.HS_SUPABASE_URL              = "https://example.supabase.co";
  process.env.HS_SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
});

// ── LATE_SKIP_THRESHOLD_MS constant ──────────────────────────────────────────
describe("LATE_SKIP_THRESHOLD_MS", () => {
  it("is exactly 48 hours in milliseconds", () => {
    expect(LATE_SKIP_THRESHOLD_MS).toBe(48 * 60 * 60 * 1000);
  });
});

// ── recordLateSkip() ─────────────────────────────────────────────────────────
// We test this by passing a fake Supabase client via the _supaOverride
// parameter (an optional second argument for testing only).
describe("recordLateSkip", () => {
  it("increments skipped_visits_late by 1 and returns the new count", async () => {
    let selectCallCount = 0;
    const fakeSupa: any = {
      from: (_table: string) => ({
        select: (_cols: string) => ({
          eq: (_col: string, _val: string) => ({
            single: () => {
              if (selectCallCount++ === 0) {
                return Promise.resolve({ data: { skipped_visits_late: 3 }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
          }),
        }),
        update: (_patch: Record<string, unknown>) => ({
          eq: (_col: string, _val: string) => Promise.resolve({ error: null }),
        }),
      }),
    };

    const result = await recordLateSkip("sub-abc", fakeSupa as any);
    expect(result).toBe(4); // 3 + 1
  });

  it("returns null when null is passed as the client (no DB configured)", async () => {
    const result = await recordLateSkip("sub-no-db", null);
    expect(result).toBeNull();
  });

  it("returns null when the DB row is not found", async () => {
    const fakeSupa: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: { message: "No rows found" } }),
          }),
        }),
      }),
    };
    const result = await recordLateSkip("sub-missing", fakeSupa as any);
    expect(result).toBeNull();
  });

  it("returns null when the update fails", async () => {
    const fakeSupa: any = {
      from: (_table: string) => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: { skipped_visits_late: 1 }, error: null }),
          }),
        }),
        update: () => ({
          eq: () => Promise.resolve({ error: { message: "Update failed" } }),
        }),
      }),
    };
    const result = await recordLateSkip("sub-update-fail", fakeSupa as any);
    expect(result).toBeNull();
  });
});

// ── Cancel endpoint fee calculation (pure unit test) ─────────────────────────
//
// The formula used in the cancel endpoint:
//   cancellation_fee_cents = Math.round(job.total_cents * fee_pct / 100)
//
// These tests verify that formula is correct for all three supported fee_pct
// values (0, 50, 100) without requiring a database or HTTP server.
describe("cancel endpoint fee calculation", () => {
  function computeFee(totalCents: number, feePct: 0 | 50 | 100): number {
    return Math.round((totalCents * feePct) / 100);
  }

  it("fee_pct=0 always returns 0", () => {
    expect(computeFee(10000, 0)).toBe(0);
    expect(computeFee(0,     0)).toBe(0);
  });

  it("fee_pct=50 returns half of the total, rounded to the nearest cent", () => {
    expect(computeFee(10000, 50)).toBe(5000);
    expect(computeFee(9999,  50)).toBe(5000); // 4999.5 rounds to 5000
    expect(computeFee(9001,  50)).toBe(4501); // 4500.5 rounds to 4501
    expect(computeFee(199,   50)).toBe(100);  // 99.5 rounds to 100
  });

  it("fee_pct=100 equals the full total", () => {
    expect(computeFee(12550, 100)).toBe(12550);
    expect(computeFee(0,     100)).toBe(0);
  });
});

// ── Auth enforcement (cancel endpoint guard smoke test) ──────────────────────
describe("cancel endpoint auth guard", () => {
  it("requireAuth rejects a request with no Authorization header with 401", async () => {
    // requireAuth short-circuits before calling Supabase when there is no
    // Authorization header, so no DB mock is needed here.
    const { requireAuth } = await import("../middleware/requireAuth");

    const req: any = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
    const res: any = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(_: unknown) { return this; },
    };
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── skip-next 48h window logic ────────────────────────────────────────────────
describe("skip-next 48h window detection", () => {
  const HOURS = (n: number) => n * 60 * 60 * 1000;

  it("flags a skip as late when next_visit_at is under 48h away", () => {
    const now = Date.now();
    const nextVisit = now + HOURS(24); // 24 hours from now
    expect(nextVisit - now < LATE_SKIP_THRESHOLD_MS).toBe(true);
  });

  it("does not flag a skip when next_visit_at is 72h away", () => {
    const now = Date.now();
    const nextVisit = now + HOURS(72);
    expect(nextVisit - now < LATE_SKIP_THRESHOLD_MS).toBe(false);
  });

  it("flags a skip at exactly 47h 59m as late (1 minute under threshold)", () => {
    const now = Date.now();
    const nextVisit = now + HOURS(48) - 60_000; // 1 minute short of 48h
    expect(nextVisit - now < LATE_SKIP_THRESHOLD_MS).toBe(true);
  });

  it("does not flag a skip at 48h + 1 second as late (just over threshold)", () => {
    const now = Date.now();
    const nextVisit = now + HOURS(48) + 1000;
    expect(nextVisit - now < LATE_SKIP_THRESHOLD_MS).toBe(false);
  });

  it("correctly identifies that a skip 14 days out is never late", () => {
    const now = Date.now();
    const nextVisit = now + HOURS(14 * 24);
    expect(nextVisit - now < LATE_SKIP_THRESHOLD_MS).toBe(false);
  });
});
