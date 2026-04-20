import { describe, it, expect } from "vitest";
import {
  validateBuffer,
  findOpenSlot,
  validateBookingSlots,
  generateBookingReference,
  BOOKING_BUFFER_HOURS,
} from "../booking";
import {
  largeHomeAddOn,
  defaultContractorCount,
  maxContractorCount,
  computePricing,
} from "../pricing";

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

describe("largeHomeAddOn (tiered surcharge)", () => {
  it("returns $0 for homes up to 2,500 sq ft", () => {
    expect(largeHomeAddOn(0)).toBe(0);
    expect(largeHomeAddOn(1500)).toBe(0);
    expect(largeHomeAddOn(2500)).toBe(0);
  });

  it("returns $75 for 2,501–3,000 sq ft", () => {
    expect(largeHomeAddOn(2501)).toBe(75);
    expect(largeHomeAddOn(2800)).toBe(75);
    expect(largeHomeAddOn(3000)).toBe(75);
  });

  it("returns $100 for 3,001–3,500 sq ft", () => {
    expect(largeHomeAddOn(3001)).toBe(100);
    expect(largeHomeAddOn(3500)).toBe(100);
  });

  it("returns $150 for 3,501–4,000 sq ft", () => {
    expect(largeHomeAddOn(3501)).toBe(150);
    expect(largeHomeAddOn(4000)).toBe(150);
  });

  it("returns $200 for 4,001–5,000 sq ft", () => {
    expect(largeHomeAddOn(4001)).toBe(200);
    expect(largeHomeAddOn(5000)).toBe(200);
  });

  it("clamps anything over 5,000 sq ft to the $200 top tier", () => {
    expect(largeHomeAddOn(5001)).toBe(200);
    expect(largeHomeAddOn(8000)).toBe(200);
    expect(largeHomeAddOn(99999)).toBe(200);
  });
});

describe("contractor assignment by sq ft", () => {
  it("assigns 1 contractor for homes up to 2,500 sq ft", () => {
    expect(defaultContractorCount(0)).toBe(1);
    expect(defaultContractorCount(1500)).toBe(1);
    expect(defaultContractorCount(2500)).toBe(1);
  });

  it("auto-assigns 2 contractors for 2,501+ sq ft", () => {
    expect(defaultContractorCount(2501)).toBe(2);
    expect(defaultContractorCount(3500)).toBe(2);
    expect(defaultContractorCount(4000)).toBe(2);
    expect(defaultContractorCount(10000)).toBe(2);
  });

  it("caps the admin override ceiling at 2 for <4001 sq ft and 3 for 4001+", () => {
    expect(maxContractorCount(2000)).toBe(1);
    expect(maxContractorCount(2501)).toBe(2);
    expect(maxContractorCount(4000)).toBe(2);
    expect(maxContractorCount(4001)).toBe(3);
    expect(maxContractorCount(10000)).toBe(3);
  });
});

describe("computePricing — Large Home Add-On integration", () => {
  it("adds the add-on on top of base price, NEVER discounted", () => {
    // 3,000 sqft Standard Clean with WELCOME15:
    //   sqftPrice = 3000 * 0.29 = $870
    //   minimum = $289  →  discountable portion = 870 - 289 = $581
    //   15% discount = $87.15  →  discountedBase = 870 - 87.15 = $782.85
    //   + Large Home Add-On = $75 (2501–3000 tier)
    //   subtotal = 782.85 + 75 = $857.85
    const p = computePricing({
      serviceType: "standard",
      squareFootage: 3000,
      welcomeEligible: true,
    });
    expect(p.largeHomeAddOn).toBe(75);
    expect(p.discount).toBeCloseTo(87.15, 2);
    expect(p.subtotal).toBeCloseTo(857.85, 2);
  });

  it("is $0 for small homes (no add-on, no line item)", () => {
    const p = computePricing({ serviceType: "standard", squareFootage: 1500 });
    expect(p.largeHomeAddOn).toBe(0);
    expect(p.lineItems.some((l) => l.category === "large_home_addon")).toBe(false);
  });

  it("emits a dedicated line item when the add-on applies", () => {
    const p = computePricing({ serviceType: "deep", squareFootage: 4500 });
    const line = p.lineItems.find((l) => l.category === "large_home_addon");
    expect(line?.lineTotal).toBe(200);
    expect(line?.label).toContain("Large Home");
  });
});
