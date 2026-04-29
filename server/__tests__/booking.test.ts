import { describe, it, expect } from "vitest";
import {
  validateBuffer,
  findOpenSlot,
  validateBookingSlots,
  generateBookingReference,
  BOOKING_BUFFER_HOURS,
} from "../booking";

const hours = (n: number) => n * 60 * 60 * 1000;

describe("validateBuffer (48h rule)", () => {
  it("rejects slots inside the 48h window", () => {
    const now = new Date("2026-04-18T00:00:00Z");
    const tooSoon = {
      start: new Date(now.getTime() + hours(12)).toISOString(),
      end: new Date(now.getTime() + hours(14)).toISOString(),
    };
    const err = validateBuffer(tooSoon, now);
    expect(err).not.toBeNull();
    expect(err?.kind).toBe("buffer_violation");
  });

  it("rejects slots exactly 47h59m out", () => {
    const now = new Date("2026-04-18T00:00:00Z");
    const edge = {
      start: new Date(now.getTime() + hours(47) + 59 * 60 * 1000).toISOString(),
      end: new Date(now.getTime() + hours(49)).toISOString(),
    };
    const err = validateBuffer(edge, now);
    expect(err?.kind).toBe("buffer_violation");
  });

  it("accepts a slot exactly 48h+1min out", () => {
    const now = new Date("2026-04-18T00:00:00Z");
    const ok = {
      start: new Date(now.getTime() + hours(48) + 60_000).toISOString(),
      end: new Date(now.getTime() + hours(50)).toISOString(),
    };
    expect(validateBuffer(ok, now)).toBeNull();
  });

  it("rejects malformed or zero-length slots", () => {
    const now = new Date("2026-04-18T00:00:00Z");
    expect(validateBuffer({ start: "nope", end: "nope" }, now)?.kind).toBe(
      "invalid_slot",
    );
    const sameTime = new Date(now.getTime() + hours(72)).toISOString();
    expect(
      validateBuffer({ start: sameTime, end: sameTime }, now)?.kind,
    ).toBe("invalid_slot");
  });

  it("uses a configurable buffer in hours", () => {
    expect(BOOKING_BUFFER_HOURS).toBe(48);
  });
});

describe("findOpenSlot", () => {
  const start = "2026-04-22T14:00:00.000Z";
  const end = "2026-04-22T16:00:00.000Z";

  it("returns ok when the calendar advertises the slot as available", () => {
    const res = findOpenSlot(
      { start, end },
      [{ start, end, status: "available" }],
    );
    expect(res.ok).toBe(true);
  });

  it("rejects a slot that's booked or past", () => {
    const res = findOpenSlot(
      { start, end },
      [{ start, end, status: "booked" }],
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.kind).toBe("slot_unavailable");
  });

  it("rejects a slot that isn't in the feed at all", () => {
    const res = findOpenSlot({ start, end }, []);
    expect(res.ok).toBe(false);
  });

  it("matches on start only — accepts a 4h Standard job against a 2h slot grid", () => {
    // Regression: backend slot grid is 2h windows, but Standard Clean is a
    // 4h job. Frontend sends start matching the grid + end at start+4h. We
    // must match by start so the booking goes through and the route handler
    // can block the full 4h on Google Calendar.
    const standardEnd = "2026-04-22T18:00:00.000Z"; // 4h after start
    const res = findOpenSlot(
      { start, end: standardEnd },
      [{ start, end, status: "available" }],
    );
    expect(res.ok).toBe(true);
  });
});

describe("validateBookingSlots — duration preservation", () => {
  const now = new Date("2026-04-18T00:00:00Z");

  it("preserves caller-supplied end so route handler blocks full job duration", async () => {
    const start = new Date(now.getTime() + hours(72)).toISOString();
    const gridEnd = new Date(now.getTime() + hours(74)).toISOString(); // 2h grid
    const jobEnd = new Date(now.getTime() + hours(76)).toISOString();  // 4h Standard
    const res = await validateBookingSlots(
      [{ start, end: jobEnd }],
      { now, available: [{ start, end: gridEnd, status: "available" }] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.slots[0].start).toBe(start);
      expect(res.slots[0].end).toBe(jobEnd); // not gridEnd
    }
  });
});

describe("validateBookingSlots", () => {
  const now = new Date("2026-04-18T00:00:00Z");
  const startOk = new Date(now.getTime() + hours(72)).toISOString();
  const endOk = new Date(now.getTime() + hours(74)).toISOString();

  it("accepts an array of buffered + available slots", async () => {
    const res = await validateBookingSlots(
      [{ start: startOk, end: endOk }],
      {
        now,
        available: [{ start: startOk, end: endOk, status: "available" }],
      },
    );
    expect(res.ok).toBe(true);
  });

  it("short-circuits on buffer violation before checking the calendar", async () => {
    const tooSoon = new Date(now.getTime() + hours(6)).toISOString();
    const soonEnd = new Date(now.getTime() + hours(8)).toISOString();
    const res = await validateBookingSlots(
      [{ start: tooSoon, end: soonEnd }],
      { now, available: [] },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.kind).toBe("buffer_violation");
  });

  it("rejects empty input with invalid_slot", async () => {
    const res = await validateBookingSlots([], { now, available: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.err.kind).toBe("invalid_slot");
  });
});

describe("generateBookingReference", () => {
  it("produces a HS-YYYYMMDD-XXXXXX formatted code", () => {
    const ref = generateBookingReference(
      new Date("2026-04-18T12:00:00Z"),
      () => 0.5,
    );
    expect(ref).toMatch(/^HS-\d{8}-[A-Z2-9]{6}$/);
    expect(ref.startsWith("HS-20260418-")).toBe(true);
  });

  it("uses an alphabet without ambiguous characters (no 0/O/1/I)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const r = Math.random;
      const ref = generateBookingReference(new Date(), r);
      const suffix = ref.split("-")[2];
      for (const ch of suffix) seen.add(ch);
    }
    expect(seen.has("0")).toBe(false);
    expect(seen.has("O")).toBe(false);
    expect(seen.has("1")).toBe(false);
    expect(seen.has("I")).toBe(false);
  });

  it("is deterministic for a fixed PRNG stream", () => {
    let i = 0;
    const seq = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5];
    const rand = () => seq[i++ % seq.length];
    const a = generateBookingReference(new Date("2026-04-18T00:00:00Z"), rand);
    i = 0;
    const b = generateBookingReference(new Date("2026-04-18T00:00:00Z"), rand);
    expect(a).toBe(b);
  });
});
