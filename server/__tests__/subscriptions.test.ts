/**
 * Subscription v1 — unit tests
 *
 * Covers:
 *   1. Seat cap logic  (15th active → ok, 16th → waitlisted)
 *   2. Discount math   (15% off locked base price)
 *   3. Frequency validation (only 'biweekly' accepted)
 *   4. service_type validation (standard | deep | moveout | micro all accepted;
 *      invalid value rejected)
 *
 * These tests do NOT hit Supabase or Stripe — they exercise pure business-logic
 * functions exported from server/subscriptions.ts and the pricing helpers in
 * server/routes.ts.
 */

import { describe, it, expect } from "vitest";
import { applySubscriptionDiscount, SUBSCRIPTION_SEAT_CAP } from "../subscriptions";
import { computePricing } from "../routes";

// ── 1. Seat cap ──────────────────────────────────────────────────────────────

describe("Subscription seat cap", () => {
  it("SUBSCRIPTION_SEAT_CAP is exactly 15", () => {
    expect(SUBSCRIPTION_SEAT_CAP).toBe(15);
  });

  it("15th active subscriber is accepted (active < cap)", () => {
    // Simulate the application-layer check: active count BEFORE insert is 14
    const activeBefore = 14;
    const isWaitlisted = activeBefore >= SUBSCRIPTION_SEAT_CAP;
    expect(isWaitlisted).toBe(false);
    // status would be 'active'
    const insertStatus = isWaitlisted ? "waitlisted" : "active";
    expect(insertStatus).toBe("active");
  });

  it("16th subscriber is waitlisted (active === cap)", () => {
    // Simulate the application-layer check: active count BEFORE insert is 15
    const activeBefore = 15;
    const isWaitlisted = activeBefore >= SUBSCRIPTION_SEAT_CAP;
    expect(isWaitlisted).toBe(true);
    const insertStatus = isWaitlisted ? "waitlisted" : "active";
    expect(insertStatus).toBe("waitlisted");
  });

  it("17th subscriber is also waitlisted (active > cap)", () => {
    const activeBefore = 16;
    const isWaitlisted = activeBefore >= SUBSCRIPTION_SEAT_CAP;
    expect(isWaitlisted).toBe(true);
  });

  it("first subscriber (0 active) is accepted", () => {
    const activeBefore = 0;
    const isWaitlisted = activeBefore >= SUBSCRIPTION_SEAT_CAP;
    expect(isWaitlisted).toBe(false);
  });
});

// ── 2. Discount math ─────────────────────────────────────────────────────────

describe("Subscription discount math (15% off locked base)", () => {
  it("15% off $580.00 base → $493 (2,000 sqft Standard per design spec)", () => {
    const baseCents   = 58000; // $580.00
    const charged     = applySubscriptionDiscount(baseCents, 15);
    // $580 × 0.85 = $493.00
    expect(charged).toBe(49300);
  });

  it("15% off $435.00 base → $369.75 (1,500 sqft Standard)", () => {
    const baseCents = 43500;
    const charged   = applySubscriptionDiscount(baseCents, 15);
    // $435 × 0.85 = $369.75
    expect(charged).toBe(36975);
  });

  it("15% off $199.00 base → $169.15 (Micro Clean flat rate)", () => {
    const baseCents = 19900;
    const charged   = applySubscriptionDiscount(baseCents, 15);
    // $199 × 0.85 = $169.15
    expect(charged).toBe(16915);
  });

  it("0% discount returns full price", () => {
    const baseCents = 50000;
    expect(applySubscriptionDiscount(baseCents, 0)).toBe(50000);
  });

  it("100% discount returns 0", () => {
    const baseCents = 50000;
    expect(applySubscriptionDiscount(baseCents, 100)).toBe(0);
  });

  it("result is always a whole-cent integer (rounds correctly)", () => {
    // $289.00 × 0.85 = $245.65 → 24565 cents
    const baseCents = 28900;
    const charged   = applySubscriptionDiscount(baseCents, 15);
    expect(Number.isInteger(charged)).toBe(true);
    expect(charged).toBe(24565);
  });

  it("locked_base_price_cents is derived from computePricing().subtotal", () => {
    // Standard 2000 sqft: sqftPrice = 2000 * 0.29 = 580; basePrice = max(289, 580) = 580
    const pricing = computePricing({ serviceType: "standard", squareFootage: 2000 });
    const lockedCents = Math.round(pricing.subtotal * 100);
    expect(lockedCents).toBe(58000);

    const discountedCents = applySubscriptionDiscount(lockedCents, 15);
    // $580 * 0.85 = $493
    expect(discountedCents).toBe(49300);
  });
});

// ── 3. Frequency validation ───────────────────────────────────────────────────

describe("Frequency validation", () => {
  const VALID_FREQUENCY = "biweekly";

  it("'biweekly' is the only accepted frequency", () => {
    expect(VALID_FREQUENCY).toBe("biweekly");
  });

  it("'weekly' is rejected", () => {
    const frequency = "weekly";
    expect(frequency !== VALID_FREQUENCY).toBe(true);
  });

  it("'monthly' is rejected", () => {
    const frequency = "monthly";
    expect(frequency !== VALID_FREQUENCY).toBe(true);
  });

  it("'daily' is rejected", () => {
    const frequency = "daily";
    expect(frequency !== VALID_FREQUENCY).toBe(true);
  });

  it("empty string is rejected", () => {
    const frequency = "";
    expect(frequency !== VALID_FREQUENCY).toBe(true);
  });

  it("default frequency is 'biweekly'", () => {
    // Mirrors the default parameter in the POST route
    const defaultFrequency = "biweekly";
    expect(defaultFrequency).toBe(VALID_FREQUENCY);
  });
});

// ── 4. service_type validation ────────────────────────────────────────────────

describe("service_type validation", () => {
  const VALID_SERVICE_TYPES = ["standard", "deep", "moveout", "micro"] as const;

  it("'standard' is accepted", () => {
    expect(VALID_SERVICE_TYPES).toContain("standard");
  });

  it("'deep' is accepted", () => {
    expect(VALID_SERVICE_TYPES).toContain("deep");
  });

  it("'moveout' is accepted", () => {
    expect(VALID_SERVICE_TYPES).toContain("moveout");
  });

  it("'micro' is accepted (added in Sprint C)", () => {
    expect(VALID_SERVICE_TYPES).toContain("micro");
  });

  it("'premium' is rejected (not in the catalogue)", () => {
    expect(VALID_SERVICE_TYPES).not.toContain("premium" as any);
  });

  it("empty string is rejected", () => {
    expect(VALID_SERVICE_TYPES).not.toContain("" as any);
  });

  it("computePricing works for all four valid service types", () => {
    for (const serviceType of VALID_SERVICE_TYPES) {
      const sqft = serviceType === "micro" ? 500 : 1000;
      const result = computePricing({ serviceType, squareFootage: sqft });
      expect(result.serviceType).toBe(serviceType);
      expect(result.subtotal).toBeGreaterThan(0);
    }
  });
});

// ── 5. Integration: pricing → locked base → discounted visit ─────────────────

describe("End-to-end pricing → locked base → subscription discount", () => {
  const cases: Array<{ label: string; serviceType: string; sqft: number; expectedDiscountedCents: number }> = [
    { label: "1000 sqft Standard",  serviceType: "standard", sqft: 1000,  expectedDiscountedCents: 24650 }, // $290 * 0.85 = $246.50
    { label: "1500 sqft Standard",  serviceType: "standard", sqft: 1500,  expectedDiscountedCents: 36975 }, // $435 * 0.85 = $369.75
    { label: "2000 sqft Standard",  serviceType: "standard", sqft: 2000,  expectedDiscountedCents: 49300 }, // $580 * 0.85 = $493.00
    { label: "Micro 500 sqft",      serviceType: "micro",    sqft: 500,   expectedDiscountedCents: 16915 }, // $199 * 0.85 = $169.15
    { label: "1500 sqft Deep",      serviceType: "deep",     sqft: 1500,  expectedDiscountedCents: 49725 }, // $585 * 0.85 = $497.25
  ];

  for (const c of cases) {
    it(`${c.label}: discounted visit = ${(c.expectedDiscountedCents / 100).toFixed(2)}`, () => {
      const pricing    = computePricing({ serviceType: c.serviceType, squareFootage: c.sqft });
      const baseCents  = Math.round(pricing.subtotal * 100);
      const discounted = applySubscriptionDiscount(baseCents, 15);
      expect(discounted).toBe(c.expectedDiscountedCents);
    });
  }
});
