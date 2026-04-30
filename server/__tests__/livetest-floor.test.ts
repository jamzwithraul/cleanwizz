import { describe, it, expect } from "vitest";
import { computePricing, getContractorPayout } from "../routes";

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

  it("forces basePrice to $10 on Deep Clean", () => {
    const result = computePricing({
      serviceType: "deep",
      squareFootage: 1000,
      discountCode: "LIVETEST_FLOOR",
    });
    expect(result.basePrice).toBe(10);
    expect(result.subtotal).toBe(10);
    expect(result.total).toBeCloseTo(11.3, 2);
  });

  it("forces basePrice to $10 on Move-out Clean", () => {
    const result = computePricing({
      serviceType: "moveout",
      squareFootage: 1000,
      discountCode: "LIVETEST_FLOOR",
    });
    expect(result.basePrice).toBe(10);
    expect(result.subtotal).toBe(10);
    expect(result.total).toBeCloseTo(11.3, 2);
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

  it("floors contractor pay_amount to $0.50 on Standard", () => {
    expect(getContractorPayout("standard", "LIVETEST_FLOOR")).toBe(0.5);
  });

  it("floors contractor pay_amount to $0.50 on Deep", () => {
    expect(getContractorPayout("deep", "LIVETEST_FLOOR")).toBe(0.5);
  });

  it("floors contractor pay_amount to $0.50 on Move-out", () => {
    expect(getContractorPayout("moveout", "LIVETEST_FLOOR")).toBe(0.5);
  });

  it("does NOT floor contractor pay for Micro (LIVETEST_FLOOR excludes Micro)", () => {
    expect(getContractorPayout("micro", "LIVETEST_FLOOR")).toBe(120);
  });

  it("does NOT floor contractor pay when no promo code is used", () => {
    expect(getContractorPayout("standard")).toBe(160);
    expect(getContractorPayout("deep")).toBe(240);
    expect(getContractorPayout("moveout")).toBe(320);
  });

  it("contractor floor is case-insensitive on the promo code", () => {
    expect(getContractorPayout("standard", "livetest_floor")).toBe(0.5);
  });
});
