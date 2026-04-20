/**
 * Pricing helpers — pure, no I/O, unit-testable.
 *
 * Centralizes:
 *   • Per-service minimums and sqft rates (Standard / Deep / Move-In-Out)
 *   • Flat SOLO contractor payouts (charged per contractor on team jobs)
 *   • Large Home Add-On tiers (applied on top of base, never discounted)
 *   • Contractor-count assignment rules (1, 2, or 3 — with admin override ceiling)
 *
 * `routes.ts` re-exports these so existing imports keep working.
 */

export type ServiceType = "standard" | "deep" | "moveout";

export const SERVICE_PRICING: Record<ServiceType, { minimum: number; sqftRate: number; label: string }> = {
  standard: { minimum: 289, sqftRate: 0.29, label: "Standard Clean" },
  deep:     { minimum: 499, sqftRate: 0.39, label: "Deep Clean" },
  moveout:  { minimum: 699, sqftRate: 0.49, label: "Move-In/Move-Out Clean" },
};

// Per-contractor SOLO payout. Team jobs pay this rate to EACH assigned contractor.
// Total company payout = CONTRACTOR_PAYOUT[service] × assigned_contractor_count.
export const CONTRACTOR_PAYOUT: Record<ServiceType, number> = {
  standard: 160,
  deep:     240,
  moveout:  320,
};

export const LARGE_HOME_ADDON_LABEL = "Large Home Add-On";

export function resolveService(serviceType: string): ServiceType {
  if (serviceType === "deep" || serviceType === "moveout" || serviceType === "standard") return serviceType;
  return "standard";
}

export function getContractorPayout(serviceType: string): number {
  return CONTRACTOR_PAYOUT[resolveService(serviceType)];
}

/**
 * Tiered surcharge applied on top of the base price for larger homes.
 * Never discounted (same treatment as regular add-ons). Homes over
 * 5,000 sq ft clamp to the top tier ($200) — there is no further
 * escalation.
 */
export function largeHomeAddOn(squareFootage: number): number {
  const sqft = Math.max(0, Math.floor(squareFootage || 0));
  if (sqft <= 2500) return 0;
  if (sqft <= 3000) return 75;
  if (sqft <= 3500) return 100;
  if (sqft <= 4000) return 150;
  // 4,001+ (including anything >5,000, which is clamped to $200).
  return 200;
}

/**
 * Contractor-count rules:
 *   0–2,500 sq ft → 1
 *   2,501–4,000 sq ft → 2 (auto, no override)
 *   4,001+ sq ft → 2 default, admin may override to 3
 */
export function defaultContractorCount(squareFootage: number): 1 | 2 {
  const sqft = Math.max(0, Math.floor(squareFootage || 0));
  return sqft >= 2501 ? 2 : 1;
}

/** Ceiling for the admin override control. */
export function maxContractorCount(squareFootage: number): 1 | 2 | 3 {
  const sqft = Math.max(0, Math.floor(squareFootage || 0));
  if (sqft >= 4001) return 3;
  if (sqft >= 2501) return 2;
  return 1;
}

/** Total payout the company owes for a job, given the assigned team size. */
export function totalCompanyPayout(serviceType: string, contractorCount: number): number {
  const count = Math.max(1, Math.min(3, Math.floor(contractorCount || 1)));
  return CONTRACTOR_PAYOUT[resolveService(serviceType)] * count;
}

// ── computePricing (pure) ────────────────────────────────────────────────────
// Kept here (not in routes.ts) so tests can import without pulling in the
// Express/server-only dependencies.

export const OVEN_PRICE = 100;
export const LAUNDRY_PRICE = 100;
export const HST_RATE = 0.13;

export const OVEN_NOTICE = "Easy-Off is used for deep oven cleaning. This product emits a strong odour. We recommend opening windows for ventilation during and after the service.";
export const LAUNDRY_NOTICE = "Client is responsible for sorting special care items (delicates, dry-clean-only, etc.) before the service and for putting laundry away after completion.";

// Non-stacking discount rates — the larger of the two eligible discounts wins.
export const DISCOUNT_RATES = {
  welcome: 0.15, // WELCOME15 single-booking promo
  multi:   0.20, // 2+ sessions multi-booking
};

const round2 = (n: number) => parseFloat(n.toFixed(2));

export interface ComputePricingInput {
  serviceType: ServiceType | string;
  squareFootage: number;
  addons?: string[];
  sessions?: number;
  discountCode?: string | null;
  welcomeEligible?: boolean;
  multiEligible?: boolean;
  settings?: any;
}

export interface PricingBreakdown {
  serviceType: ServiceType;
  minimum: number;
  sqftRate: number;
  sqftPrice: number;
  basePrice: number;
  discountablePortion: number;
  discountPct: number;
  discountLabel: string | null;
  discount: number;
  discountedBase: number;
  addOnsTotal: number;
  largeHomeAddOn: number;
  subtotal: number;
  hst: number;
  total: number;
  lineItems: { label: string; quantity: number; unitPrice: number; lineTotal: number; category: string }[];
}

export function computePricing(input: ComputePricingInput): PricingBreakdown {
  const service = resolveService(input.serviceType);
  const sqft = Math.max(0, Math.floor(input.squareFootage || 0));
  const { minimum, sqftRate, label } = SERVICE_PRICING[service];
  const s = input.settings || {};

  const sqftPrice = round2(sqft * sqftRate);
  const basePrice = Math.max(minimum, sqftPrice);

  let discountPct = 0;
  let discountLabel: string | null = null;
  if (input.multiEligible && input.welcomeEligible) {
    discountPct = Math.max(DISCOUNT_RATES.multi, DISCOUNT_RATES.welcome);
    discountLabel = discountPct === DISCOUNT_RATES.multi ? "Multi-Booking (20%)" : "Welcome (15%)";
  } else if (input.multiEligible) {
    discountPct = DISCOUNT_RATES.multi;
    discountLabel = "Multi-Booking (20%)";
  } else if (input.welcomeEligible) {
    discountPct = DISCOUNT_RATES.welcome;
    discountLabel = "Welcome (15%)";
  }

  const discountablePortion = Math.max(0, round2(sqftPrice - minimum));
  const discount = round2(discountablePortion * discountPct);
  const discountedBase = round2(basePrice - discount);

  const addonCatalog: Record<string, { label: string; price: number; notice?: string }> = {
    fridge:     { label: "Inside fridge",       price: typeof s.fridgePrice === "number" ? s.fridgePrice : 30 },
    windows:    { label: "Interior windows",     price: typeof s.windowsPrice === "number" ? s.windowsPrice : 40 },
    baseboards: { label: "Baseboards",           price: typeof s.baseboardsPrice === "number" ? s.baseboardsPrice : 35 },
    grout:      { label: "Grout scrubbing",      price: typeof s.groutPrice === "number" ? s.groutPrice : 35 },
    oven:       { label: "In-Oven Cleaning",     price: OVEN_PRICE, notice: OVEN_NOTICE },
    laundry:    { label: "Laundry Wash & Fold",  price: LAUNDRY_PRICE, notice: LAUNDRY_NOTICE },
  };
  const addonLines: { label: string; quantity: number; unitPrice: number; lineTotal: number; category: string }[] = [];
  for (const a of input.addons || []) {
    const entry = addonCatalog[a];
    if (!entry) continue;
    addonLines.push({ label: entry.label, quantity: 1, unitPrice: entry.price, lineTotal: entry.price, category: "addon" });
  }
  const addOnsTotal = round2(addonLines.reduce((sum, i) => sum + i.lineTotal, 0));

  // Large Home Add-On sits outside the discount — same treatment as add-ons.
  const largeHomeFee = largeHomeAddOn(sqft);

  const subtotal = round2(discountedBase + addOnsTotal + largeHomeFee);
  const hst = round2(subtotal * HST_RATE);
  const total = round2(subtotal + hst);

  const lineItems: { label: string; quantity: number; unitPrice: number; lineTotal: number; category: string }[] = [];
  lineItems.push({
    label: `${label} — base (minimum $${minimum.toFixed(2)})`,
    quantity: 1,
    unitPrice: minimum,
    lineTotal: minimum,
    category: "base",
  });
  if (sqftPrice > minimum) {
    lineItems.push({
      label: `Sqft upgrade (${sqft} sq ft @ $${sqftRate}/sq ft, above minimum)`,
      quantity: sqft,
      unitPrice: sqftRate,
      lineTotal: round2(sqftPrice - minimum),
      category: "sqft",
    });
  }
  lineItems.push(...addonLines);
  if (largeHomeFee > 0) {
    lineItems.push({
      label: LARGE_HOME_ADDON_LABEL,
      quantity: 1,
      unitPrice: largeHomeFee,
      lineTotal: largeHomeFee,
      category: "large_home_addon",
    });
  }

  return {
    serviceType: service,
    minimum,
    sqftRate,
    sqftPrice,
    basePrice,
    discountablePortion,
    discountPct,
    discountLabel,
    discount,
    discountedBase,
    addOnsTotal,
    largeHomeAddOn: largeHomeFee,
    subtotal,
    hst,
    total,
    lineItems,
  };
}
