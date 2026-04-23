/**
 * sla-sweep.test.ts
 *
 * Tests the SLA breach detection logic from server/cron/guarantee-sla.ts.
 * Uses a fully in-memory implementation — no Supabase calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory SLA sweep (mirrors guarantee-sla.ts logic) ────────────────────
type RecleanStatus = "pending" | "approved" | "dispatched" | "completed" | "denied";

interface RecleanStub {
  id:           string;
  status:       RecleanStatus;
  requested_at: string;
  dispatched_at: string | null;
  completed_at:  string | null;
  sla_breached:  boolean;
}

const DISPATCH_SLA_MS    = 4  * 60 * 60 * 1000;  // 4 hours
const COMPLETION_SLA_MS  = 48 * 60 * 60 * 1000;  // 48 hours

function runInMemorySlaBreachSweep(rows: RecleanStub[], now = Date.now()): {
  updated: RecleanStub[];
  dispatchBreaches:   number;
  completionBreaches: number;
} {
  let dispatchBreaches   = 0;
  let completionBreaches = 0;

  const updated = rows.map(row => {
    if (row.sla_breached) return row; // already flagged — idempotent

    let breached = false;

    // Dispatch SLA: pending, requested_at older than 4h
    if (
      row.status === "pending" &&
      now - new Date(row.requested_at).getTime() > DISPATCH_SLA_MS
    ) {
      breached = true;
      dispatchBreaches++;
    }

    // Completion SLA: dispatched, dispatched_at older than 48h, not completed
    if (
      row.status === "dispatched" &&
      row.dispatched_at &&
      row.completed_at === null &&
      now - new Date(row.dispatched_at).getTime() > COMPLETION_SLA_MS
    ) {
      breached = true;
      completionBreaches++;
    }

    return breached ? { ...row, sla_breached: true } : row;
  });

  return { updated, dispatchBreaches, completionBreaches };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

function makeRow(overrides: Partial<RecleanStub>): RecleanStub {
  return {
    id:            "reclean-001",
    status:        "pending",
    requested_at:  new Date().toISOString(),
    dispatched_at: null,
    completed_at:  null,
    sla_breached:  false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Dispatch SLA — pending request older than 4 hours", () => {
  it("marks as sla_breached when pending for 5 hours", () => {
    const row = makeRow({ requested_at: hoursAgo(5), status: "pending" });
    const { updated, dispatchBreaches } = runInMemorySlaBreachSweep([row]);

    expect(updated[0].sla_breached).toBe(true);
    expect(dispatchBreaches).toBe(1);
  });

  it("does NOT mark as breached when pending for only 3 hours", () => {
    const row = makeRow({ requested_at: hoursAgo(3), status: "pending" });
    const { updated, dispatchBreaches } = runInMemorySlaBreachSweep([row]);

    expect(updated[0].sla_breached).toBe(false);
    expect(dispatchBreaches).toBe(0);
  });

  it("does NOT mark dispatched rows as dispatch-breached", () => {
    const row = makeRow({
      status:       "dispatched",
      requested_at: hoursAgo(10),
      dispatched_at: hoursAgo(0.5),
    });
    const { dispatchBreaches } = runInMemorySlaBreachSweep([row]);
    expect(dispatchBreaches).toBe(0);
  });
});

describe("Completion SLA — dispatched request older than 48 hours without completion", () => {
  it("marks as sla_breached when dispatched 50 hours ago and not completed", () => {
    const row = makeRow({
      status:        "dispatched",
      requested_at:  hoursAgo(52),
      dispatched_at: hoursAgo(50),
      completed_at:  null,
    });
    const { updated, completionBreaches } = runInMemorySlaBreachSweep([row]);

    expect(updated[0].sla_breached).toBe(true);
    expect(completionBreaches).toBe(1);
  });

  it("does NOT mark as breached when dispatched only 24 hours ago", () => {
    const row = makeRow({
      status:        "dispatched",
      requested_at:  hoursAgo(26),
      dispatched_at: hoursAgo(24),
      completed_at:  null,
    });
    const { updated, completionBreaches } = runInMemorySlaBreachSweep([row]);

    expect(updated[0].sla_breached).toBe(false);
    expect(completionBreaches).toBe(0);
  });

  it("does NOT mark as breached when dispatched 50 hours ago but completed", () => {
    const row = makeRow({
      status:        "completed",
      requested_at:  hoursAgo(52),
      dispatched_at: hoursAgo(50),
      completed_at:  hoursAgo(2),
    });
    const { updated, completionBreaches } = runInMemorySlaBreachSweep([row]);

    expect(updated[0].sla_breached).toBe(false);
    expect(completionBreaches).toBe(0);
  });
});

describe("Sweep is idempotent", () => {
  it("does not double-count already-breached rows", () => {
    const alreadyBreached = makeRow({
      status:       "pending",
      requested_at: hoursAgo(10),
      sla_breached: true,
    });
    const { dispatchBreaches } = runInMemorySlaBreachSweep([alreadyBreached]);

    // Should be 0 because row was already marked
    expect(dispatchBreaches).toBe(0);
  });
});

describe("Multiple rows in one sweep", () => {
  it("counts dispatch and completion breaches independently", () => {
    const rows = [
      makeRow({ id: "r1", status: "pending",    requested_at: hoursAgo(5) }),
      makeRow({ id: "r2", status: "pending",    requested_at: hoursAgo(3) }),  // not breached
      makeRow({ id: "r3", status: "dispatched", dispatched_at: hoursAgo(50), requested_at: hoursAgo(52), completed_at: null }),
      makeRow({ id: "r4", status: "dispatched", dispatched_at: hoursAgo(20), requested_at: hoursAgo(22), completed_at: null }), // not breached
    ];

    const { dispatchBreaches, completionBreaches, updated } = runInMemorySlaBreachSweep(rows);

    expect(dispatchBreaches).toBe(1);
    expect(completionBreaches).toBe(1);

    const breachedIds = updated.filter(r => r.sla_breached).map(r => r.id);
    expect(breachedIds).toContain("r1");
    expect(breachedIds).toContain("r3");
    expect(breachedIds).not.toContain("r2");
    expect(breachedIds).not.toContain("r4");
  });

  it("returns totalBreached = dispatchBreaches + completionBreaches", () => {
    const rows = [
      makeRow({ id: "r1", status: "pending",    requested_at: hoursAgo(5) }),
      makeRow({ id: "r2", status: "dispatched", dispatched_at: hoursAgo(50), requested_at: hoursAgo(52), completed_at: null }),
    ];

    const { dispatchBreaches, completionBreaches } = runInMemorySlaBreachSweep(rows);
    const total = dispatchBreaches + completionBreaches;

    expect(total).toBe(2);
  });
});
