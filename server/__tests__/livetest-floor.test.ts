import { describe, it, expect } from "vitest";
import { computePricing } from "../routes";

// Tests for the temporary LIVETEST_FLOOR launch-test promo code.
// Remove this file when the promo code branch is removed from computePricing.
describe("LIVETEST_FLOOR launch-test promo code", () => {
  it("forces basePrice to $10 on Standard Clean", () => {
    const result = computePricing({
      serviceType: "standard",
      squareFootage: 1000,
      discountCode: "LIVETEST_FLOOR",
    });
    expect(result.basePrice).toBe(10);
    expect(result.subtotal).toBe(10);
    // HST 13% on $10 = $1.30 → total $11.30
    expect(result.hst).toBeCloseTo(1.3, 2);
    expect(result.total).toBeCloseTo(11.3, 2);
  });

  it("ignores welcome discount when LIVETEST_FLOOR is applied (no double-stack)", () => {
    const result = computePricing({
      serviceType: "standard",
      squareFootage: 1000,
      discountCode: "LIVETEST_FLOOR",
      welcomeEligible: true,
    });
    expect(result.discount).toBe(0);
    expect(result.discountLabel).toBeNull();
    expect(result.basePrice).toBe(10);
  });

  it("is case-insensitive", () => {
    const result = computePricing({
      serviceType: "standard",
      squareFootage: 1000,
      discountCode: "livetest_floor",
    });
    expect(result.basePrice).toBe(10);
  });

  it("does not apply to Micro Clean (would be ignored anyway)", () => {
    const result = computePricing({
      serviceType: "micro",
      squareFootage: 600,
      discountCode: "LIVETEST_FLOOR",
    });
    // Micro short-circuits at the top of computePricing — flat $199.
    expect(result.subtotal).toBe(199);
  });

  it("does not apply to Deep Clean", () => {
    const result = computePricing({
      serviceType: "deep",
      squareFootage: 1000,
      discountCode: "LIVETEST_FLOOR",
    });
    // Deep clean at 1000 sqft uses its own sqftRate, no floor override.
    expect(result.basePrice).toBeGreaterThan(10);
  });

  it("Standard at 1000 sqft without the code charges normal price", () => {
    const result = computePricing({
      serviceType: "standard",
      squareFootage: 1000,
    });
    // Standard min $249, sqftRate $0.25 → 1000 * 0.25 = $250 base
    expect(result.basePrice).toBe(250);
    expect(result.total).toBeCloseTo(250 * 1.13, 2);
  });
});
