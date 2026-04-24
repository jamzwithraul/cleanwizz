import { describe, it, expect } from "vitest";
import { computePricing, getContractorPayout } from "../routes";

describe("Micro Clean tier — pricing", () => {
  it("(a) micro at 400 sqft returns $199 flat subtotal", () => {
    const result = computePricing({ serviceType: "micro", squareFootage: 400 });
    expect(result.serviceType).toBe("micro");
    expect(result.subtotal).toBe(199);
    expect(result.sqftRate).toBe(0);
    expect(result.sqftPrice).toBe(0);
    expect(result.addOnsTotal).toBe(0);
    expect(result.discountablePortion).toBe(0);
    // total = subtotal + 13% HST
    expect(result.total).toBeCloseTo(199 * 1.13, 2);
  });

  it("(b) micro at 800 sqft (boundary) returns $199 flat subtotal", () => {
    const result = computePricing({ serviceType: "micro", squareFootage: 800 });
    expect(result.subtotal).toBe(199);
    expect(result.total).toBeCloseTo(199 * 1.13, 2);
  });

  it("(c) micro at 801 sqft throws a 400 error", () => {
    expect(() =>
      computePricing({ serviceType: "micro", squareFootage: 801 })
    ).toThrow("800 sq ft");
    // confirm statusCode is 400
    try {
      computePricing({ serviceType: "micro", squareFootage: 801 });
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
    }
  });

  it("(d) micro payout is $120", () => {
    expect(getContractorPayout("micro")).toBe(120);
  });

  it("micro does not have a sqft rate (no sqft upgrade possible)", () => {
    const result = computePricing({ serviceType: "micro", squareFootage: 0 });
    expect(result.sqftRate).toBe(0);
    expect(result.subtotal).toBe(199);
  });

  it("micro lineItems contains exactly one base entry with $199", () => {
    const result = computePricing({ serviceType: "micro", squareFootage: 500 });
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].lineTotal).toBe(199);
    expect(result.lineItems[0].category).toBe("base");
  });

  it("micro does not apply discounts (no discountable portion)", () => {
    const result = computePricing({
      serviceType: "micro",
      squareFootage: 600,
      welcomeEligible: true,
    });
    expect(result.discountablePortion).toBe(0);
    expect(result.discount).toBe(0);
    expect(result.subtotal).toBe(199);
  });
});

describe("Existing tiers unchanged by micro addition", () => {
  it("standard at 1500 sqft still computes correctly", () => {
    const result = computePricing({ serviceType: "standard", squareFootage: 1500 });
    // sqftPrice = 1500 * 0.25 = 375; basePrice = max(249, 375) = 375
    expect(result.subtotal).toBe(375);
  });

  it("deep at 1000 sqft still uses its minimum", () => {
    const result = computePricing({ serviceType: "deep", squareFootage: 1000 });
    // sqftPrice = 1000 * 0.35 = 350; basePrice = max(429, 350) = 429
    expect(result.subtotal).toBe(429);
  });
});
