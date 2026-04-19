import type { Express } from "express";
import type { Server } from "http";
import path from "path";
import fs from "fs";
import { getStorage } from "./storage";
import { Resend } from "resend";
import { quoteFormSchema, emailSignupRequestSchema } from "@shared/schema";
import { getAvailableSlots, bookSlot, type SlotInfo } from "./calendar";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { requireAuth, requireAuthOrInternal, ipRateLimit } from "./middleware/requireAuth";
import { validateBookingSlots, generateBookingReference, type SlotInput } from "./booking";
import { buildPayoutRecord } from "./payouts";
import { attachReminderEndpoints } from "./clientReminders";

// ── Harry Spotter Supabase (contractor data) ──────────────────────────────────
const HS_SUPABASE_URL  = process.env.HS_SUPABASE_URL  || "https://gjfeqnfmwbsfwnbepwvu.supabase.co";
const HS_SERVICE_KEY   = process.env.HS_SUPABASE_SERVICE_ROLE_KEY || "";
const hsSupa = HS_SERVICE_KEY ? createClient(HS_SUPABASE_URL, HS_SERVICE_KEY) : null;

// ── Cascade Assignment ────────────────────────────────────────────────────────
// Round-robin, 2h window if job ≥24h away, 30min if 6–24h, manual if <6h.
async function triggerCascadeAssignment(opts: {
  quoteId:     string;
  clientName:  string;
  clientAddr:  string;
  start:       string;
  end:         string;
  total:       number;
  baseUrl:     string;
}) {
  if (!hsSupa || !resend) return;

  const jobStart    = new Date(opts.start);
  const hoursAway   = (jobStart.getTime() - Date.now()) / 36e5;

  // Under 6 hours — notify owner for manual assignment
  if (hoursAway < 6) {
    await resend.emails.send({
      from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
      to:      "magic@harryspottercleaning.ca",
      subject: `⚠️ Urgent — Manual Assignment Needed (job in ${Math.round(hoursAway * 60)} min)`,
      html: `<p>A client just booked a job starting in <strong>${Math.round(hoursAway * 60)} minutes</strong>. Please assign a contractor manually.</p>
             <p>Quote: ${opts.quoteId} | Client: ${opts.clientName} | ${opts.clientAddr}</p>
             <p>Time: ${new Date(opts.start).toLocaleString("en-CA", { timeZone: "America/Toronto" })}</p>`,
    }).catch(console.error);
    return;
  }

  const windowMins = hoursAway >= 24 ? 120 : 30;

  // Get approved contractors in round-robin order
  const { data: state } = await hsSupa.from("cascade_state").select("last_contractor_index").eq("id", "singleton").single();
  const lastIdx = state?.last_contractor_index ?? 0;

  const { data: contractors } = await hsSupa
    .from("contractor_applications")
    .select("id, full_name, email")
    .eq("status", "approved")
    .order("cascade_order", { ascending: true });

  if (!contractors || contractors.length === 0) {
    // No contractors — notify owner
    await resend.emails.send({
      from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
      to:      "magic@harryspottercleaning.ca",
      subject: `⚠️ No contractors available — ${opts.clientName}`,
      html: `<p>No approved contractors found. Please assign manually.</p><p>Quote: ${opts.quoteId}</p>`,
    }).catch(console.error);
    return;
  }

  // Rotate starting contractor
  const startIdx  = lastIdx % contractors.length;
  const contractor = contractors[startIdx];

  // Update round-robin pointer
  await hsSupa.from("cascade_state").update({ last_contractor_index: startIdx + 1, updated_at: new Date().toISOString() }).eq("id", "singleton");

  // Record cascade assignment
  const expiresAt = new Date(Date.now() + windowMins * 60 * 1000).toISOString();
  await hsSupa.from("job_cascade_assignments").insert({
    quote_id:         opts.quoteId,
    contractor_id:    contractor.id,
    expires_at:       expiresAt,
    status:           "pending",
    cascade_position: 1,
  });

  // Build accept / decline URLs (Harry Spotter portal)
  const acceptUrl  = `https://harryspottercleaning.ca/contractor?action=accept&jobId=${opts.quoteId}&cid=${contractor.id}`;
  const declineUrl = `${opts.baseUrl}/api/cascade/decline?quoteId=${opts.quoteId}&cid=${contractor.id}`;

  const slotLabel = new Date(opts.start).toLocaleString("en-CA", {
    timeZone: "America/Toronto", weekday: "long", month: "long",
    day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });

  await resend.emails.send({
    from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
    to:      contractor.email,
    subject: `✨ New Mission — ${slotLabel}`,
    html: buildContractorMissionEmail({
      contractorName: contractor.full_name,
      slotLabel,
      clientAddr:     opts.clientAddr,
      total:          opts.total,
      windowMins,
      acceptUrl,
      declineUrl,
      logoUrl:        `${opts.baseUrl}/api/assets/logo`,
    }),
  }).catch(console.error);
}

function buildContractorMissionEmail(o: {
  contractorName: string;
  slotLabel:      string;
  clientAddr:     string;
  total:          number;
  windowMins:     number;
  acceptUrl:      string;
  declineUrl:     string;
  logoUrl:        string;
}) {
  const headerGrad = "linear-gradient(135deg,#6b1629 0%,#a01733 60%,#78420e 100%)";
  const windowLabel = o.windowMins >= 60 ? `${o.windowMins / 60} hour${o.windowMins > 60 ? "s" : ""}` : `${o.windowMins} minutes`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f7f6f2;font-family:'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:32px auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);">
  <div style="background:${headerGrad};padding:28px 36px;text-align:center;">
    <img src="${o.logoUrl}" alt="Harry Spotter" style="width:72px;height:72px;border-radius:50%;background:#fff;padding:6px;object-fit:contain;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto;">
    <h1 style="color:#f9bc15;margin:0;font-size:22px;font-weight:800;">Harry Spotter Cleaning Co.</h1>
    <p style="color:rgba(249,188,21,.75);margin:4px 0 0;font-size:12px;">New Mission Available</p>
  </div>
  <div style="background:#fff;padding:28px 36px;">
    <p style="font-size:16px;color:#1a0a0e;margin:0 0 16px;">Hi <strong>${o.contractorName}</strong>,</p>
    <p style="font-size:14px;color:#5a4a3a;margin:0 0 20px;line-height:1.6;">A client has booked a cleaning and you’ve been selected for the mission.  You have <strong>${windowLabel}</strong> to accept before it’s offered to the next available specialist.</p>
    <div style="background:linear-gradient(135deg,#fdf2f4,#fff8e6);border:1.5px solid #f4a3b2;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:13px;color:#7a7974;">Appointment</p>
      <p style="margin:0;font-size:16px;font-weight:700;color:#a01733;">📅 ${o.slotLabel}</p>
      <p style="margin:6px 0 0;font-size:13px;color:#7a7974;">📍 ${o.clientAddr}</p>
    </div>
    <div style="text-align:center;margin-bottom:16px;">
      <a href="${o.acceptUrl}" style="display:inline-block;background:linear-gradient(135deg,#a01733,#7e162c);color:#f9bc15;text-decoration:none;padding:14px 36px;border-radius:50px;font-weight:700;font-size:15px;">Accept This Mission ✨</a>
    </div>
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${o.declineUrl}" style="font-size:12px;color:#bab9b4;text-decoration:underline;">I cannot take this job</a>
    </div>
    <p style="font-size:11px;color:#bab9b4;text-align:center;margin:0;">This offer expires in ${windowLabel}. If you do not respond, the job will be offered to the next specialist.</p>
  </div>
  <div style="background:#1a0a0e;padding:14px 36px;text-align:center;border-top:2px solid #f9bc15;">
    <p style="color:rgba(249,188,21,.5);font-size:11px;margin:0;">Harry Spotter Cleaning Co. · harryspottercleaning.ca</p>
  </div>
</div>
</body></html>`;
}

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── Fuzzy name matching (for PRC vs Stripe Identity name check) ──────────────
// Returns a score 0..1 using token-set Jaccard + Levenshtein hybrid.
// Normalizes diacritics, punctuation, and common honorifics so "Raúl Alvarado Jr."
// matches "Raul Alvarado Junior" cleanly.
function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/\b(jr|junior|sr|senior|ii|iii|iv|mr|mrs|ms|mx|dr)\b\.?/g, "") // honorifics/suffixes
    .replace(/[^a-z0-9\s]/g, " ") // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}
function fuzzyNameScore(a: string, b: string): number {
  const an = normalizeName(a);
  const bn = normalizeName(b);
  if (!an || !bn) return 0;
  if (an === bn) return 1;
  const at = an.split(" ").filter(Boolean);
  const bt = bn.split(" ").filter(Boolean);
  const aSet: Record<string, true> = {};
  const bSet: Record<string, true> = {};
  at.forEach((t) => (aSet[t] = true));
  bt.forEach((t) => (bSet[t] = true));
  const aKeys = Object.keys(aSet);
  const bKeys = Object.keys(bSet);
  // Token-set Jaccard
  let inter = 0;
  aKeys.forEach((k) => {
    if (bSet[k]) inter++;
  });
  const union = aKeys.length + bKeys.length - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  // Levenshtein similarity on full normalized strings
  const dist = levenshtein(an, bn);
  const maxLen = Math.max(an.length, bn.length);
  const lev = maxLen === 0 ? 1 : 1 - dist / maxLen;

  // Superset boost: if one name's tokens are fully contained in the other
  // (e.g., app record "Raul Alvarado Jr" vs gov ID "Raul Edmundo Alvarado"),
  // treat the extra middle names as a non-fatal difference. We also require
  // that the first and last tokens agree so we don't inflate unrelated names.
  const smaller = aKeys.length <= bKeys.length ? aKeys : bKeys;
  const larger = aKeys.length <= bKeys.length ? bSet : aSet;
  const smallerIsSubset =
    smaller.length > 0 && smaller.every((t) => larger[t]);
  const firstLastMatch =
    at.length > 0 &&
    bt.length > 0 &&
    at[0] === bt[0] &&
    at[at.length - 1] === bt[bt.length - 1];
  if (smallerIsSubset && firstLastMatch) {
    // Guarantees the score clears the 0.82 match threshold while still
    // leaving headroom (<1) so an exact match scores higher.
    return Math.max(0.6 * jaccard + 0.4 * lev, 0.9);
  }

  // Blend: token-set captures reordering/extra middle names; Levenshtein captures typos
  return 0.6 * jaccard + 0.4 * lev;
}

// ── Pricing Engine ────────────────────────────────────────────────────────────
// Per-service minimums + sqft rates. Discounts apply ONLY to the portion of
// sqftPrice above the minimum; add-ons are layered on top and never discounted.
const OVEN_PRICE = 100;            // in-oven cleaning add-on
const LAUNDRY_PRICE = 100;         // laundry wash & fold add-on
const HST_RATE = 0.13;             // Ontario HST

type ServiceType = "standard" | "deep" | "moveout";

const SERVICE_PRICING: Record<ServiceType, { minimum: number; sqftRate: number; label: string }> = {
  standard: { minimum: 289, sqftRate: 0.29, label: "Standard Clean" },
  deep:     { minimum: 499, sqftRate: 0.39, label: "Deep Clean" },
  moveout:  { minimum: 699, sqftRate: 0.49, label: "Move-In/Move-Out Clean" },
};

// Flat contractor payouts (per job, regardless of quote total)
const CONTRACTOR_PAYOUT: Record<ServiceType, number> = {
  standard: 160,
  deep:     240,
  moveout:  320,
};

// Non-stacking discount rates. Take the larger of the eligible discounts.
const DISCOUNT_RATES = {
  welcome: 0.15,      // WELCOME15 single-booking promo
  multi:   0.20,      // 2+ sessions multi-booking
};

const OVEN_NOTICE = "Easy-Off is used for deep oven cleaning. This product emits a strong odour. We recommend opening windows for ventilation during and after the service.";
const LAUNDRY_NOTICE = "Client is responsible for sorting special care items (delicates, dry-clean-only, etc.) before the service and for putting laundry away after completion.";

const round2 = (n: number) => parseFloat(n.toFixed(2));

export interface ComputePricingInput {
  serviceType: ServiceType | string;
  squareFootage: number;
  addons?: string[];
  sessions?: number;
  discountCode?: string | null;
  welcomeEligible?: boolean; // true if this code is a welcome/15% promo
  multiEligible?: boolean;   // true if sessions >= 2
  settings?: any;            // optional: pricing_settings for addon prices
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
  subtotal: number;
  hst: number;
  total: number;
  lineItems: { label: string; quantity: number; unitPrice: number; lineTotal: number; category: string }[];
}

function resolveService(serviceType: string): ServiceType {
  if (serviceType === "deep" || serviceType === "moveout" || serviceType === "standard") return serviceType;
  return "standard";
}

export function computePricing(input: ComputePricingInput): PricingBreakdown {
  const service = resolveService(input.serviceType);
  const sqft = Math.max(0, Math.floor(input.squareFootage || 0));
  const { minimum, sqftRate, label } = SERVICE_PRICING[service];
  const s = input.settings || {};

  const sqftPrice = round2(sqft * sqftRate);
  const basePrice = Math.max(minimum, sqftPrice);

  // Determine applicable discount (NON-STACKING — take the larger)
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

  // Add-ons (never discounted) — layer on top of basePrice
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

  const subtotal = round2(discountedBase + addOnsTotal);
  const hst = round2(subtotal * HST_RATE);
  const total = round2(subtotal + hst);

  // Line items for UI / email rendering
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
    subtotal,
    hst,
    total,
    lineItems,
  };
}

export function getContractorPayout(serviceType: string): number {
  return CONTRACTOR_PAYOUT[resolveService(serviceType)];
}

// ── Email Template ────────────────────────────────────────────────────────────
function buildEmailHtml(client: any, quote: any, items: any[], baseUrl: string) {
  const itemRows = items.map(i =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${i.label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">$${i.lineTotal.toFixed(2)}</td>
    </tr>`
  ).join("");

  const expiryDate = new Date(quote.expiresAt).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  const bookUrl = `${baseUrl}/api/quotes/${quote.id}/book`;

  const logoUrl = `${baseUrl}/api/assets/logo`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Your Cleaning Quote — Harry Spotter Cleaning Co.</title></head>
<body style="margin:0;padding:0;background:#fdf8f0;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(110,22,41,0.12);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#6b1629 0%,#a01733 60%,#78420e 100%);padding:32px 40px;text-align:center;">
      <img src="${logoUrl}" alt="Harry Spotter Cleaning Co." style="width:90px;height:90px;object-fit:contain;border-radius:50%;background:#fff;padding:6px;margin-bottom:14px;display:block;margin-left:auto;margin-right:auto;" />
      <h1 style="color:#f9bc15;margin:0;font-size:26px;font-weight:800;letter-spacing:0.5px;">Harry Spotter Cleaning Co.</h1>
      <p style="color:#fde68a;margin:6px 0 0;font-size:14px;letter-spacing:0.5px;">Ottawa’s Magical Cleaning Team</p>
    </div>

    <!-- Body -->
    <div style="padding:36px 40px;">
      <h2 style="color:#6b1629;font-size:22px;margin:0 0 6px;">Hi ${client.name},</h2>
      <p style="color:#5a4a3a;font-size:15px;margin:0 0 28px;line-height:1.6;">Your cleaning quote is ready! Please review the details below and accept when you’re happy to proceed.</p>

      <!-- Line items -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#fdf2f4;">
            <th style="padding:10px 14px;text-align:left;font-size:13px;color:#7e162c;font-weight:700;border-bottom:2px solid #f4a3b2;text-transform:uppercase;letter-spacing:0.5px;">Service</th>
            <th style="padding:10px 14px;text-align:right;font-size:13px;color:#7e162c;font-weight:700;border-bottom:2px solid #f4a3b2;text-transform:uppercase;letter-spacing:0.5px;">Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      ${quote.discount > 0 ? `
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <tr>
          <td style="color:#5a4a3a;font-size:14px;padding:4px 0;">Subtotal</td>
          <td style="color:#3d2b1f;font-size:14px;text-align:right;">$${quote.subtotal.toFixed(2)} CAD</td>
        </tr>
        <tr>
          <td style="color:#166534;font-size:14px;padding:4px 0;">Discount${quote.promoCode ? ` (${quote.promoCode})` : ''}</td>
          <td style="color:#166534;font-size:14px;text-align:right;">-$${quote.discount.toFixed(2)} CAD</td>
        </tr>
      </table>` : ""}

      <!-- Oven notice -->
      ${items.some((i: any) => i.label === "In-Oven Cleaning") ? `
      <div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
        <p style="margin:0;color:#92400e;font-size:12px;line-height:1.5;"><strong>&#9888;&#65039; Oven Cleaning Notice:</strong> Easy-Off is used for deep oven cleaning. This product emits a strong odour. We recommend opening windows for ventilation during and after the service.</p>
      </div>` : ""}

      <!-- Laundry notice -->
      ${items.some((i: any) => i.label === "Laundry Wash & Fold") ? `
      <div style="background:#eff6ff;border:1px solid #3b82f6;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
        <p style="margin:0;color:#1e40af;font-size:12px;line-height:1.5;"><strong>&#128085; Laundry Notice:</strong> Client is responsible for sorting special care items (delicates, dry-clean-only, etc.) before the service and for putting laundry away after completion.</p>
      </div>` : ""}

      <!-- Total -->
      <div style="background:linear-gradient(135deg,#fdf2f4,#fff8e6);border:2px solid #f4a3b2;border-radius:12px;padding:18px 20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="font-size:18px;font-weight:700;color:#3d2b1f;">Total (incl. HST)</td>
            <td style="font-size:28px;font-weight:800;color:#a01733;text-align:right;">$${quote.total.toFixed(2)} <span style="font-size:14px;font-weight:600;color:#7a6550;">CAD</span></td>
          </tr>
        </table>
      </div>

      <!-- Transparent Pricing badge -->
      <div style="text-align:center;margin-bottom:20px;">
        <span style="display:inline-block;background:#f0fdf4;border:1px solid #86efac;border-radius:50px;padding:6px 16px;font-size:12px;color:#166534;font-weight:600;">&#10003; Transparent Pricing &#8212; No hidden fees</span>
      </div>

      <!-- Terms -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#475569;">Please Note</p>
        <ul style="margin:0;padding-left:16px;font-size:12px;color:#64748b;line-height:1.7;">
          <li>Your cleaning specialist provides all cleaning solutions, broom, mop, and vacuum.</li>
          <li>For sanitary reasons, the client must supply their own toilet brush.</li>
        </ul>
      </div>

      <p style="color:#7a6550;font-size:13px;margin-bottom:28px;">This quote is valid until <strong style="color:#3d2b1f;">${expiryDate}</strong>.</p>

      <!-- CTA Button -->
      <div style="text-align:center;margin-bottom:8px;">
        <a href="${bookUrl}" style="display:inline-block;background:linear-gradient(135deg,#a01733,#7e162c);color:#f9bc15;text-decoration:none;padding:16px 40px;border-radius:50px;font-weight:700;font-size:16px;letter-spacing:0.3px;box-shadow:0 4px 14px rgba(160,23,51,0.35);">Accept &amp; Choose a Time Slot ✨</a>
      </div>
      <p style="color:#9a8070;font-size:12px;text-align:center;margin-top:10px;">You’ll be able to pick a date and time that works for you.</p>
    </div>

    <!-- Footer -->
    <div style="padding:20px 40px;background:linear-gradient(135deg,#4a0f1c,#3d0c16);border-top:3px solid #f9bc15;text-align:center;">
      <p style="color:#fde68a;font-size:13px;font-weight:600;margin:0 0 4px;">Harry Spotter Cleaning Co.</p>
      <p style="color:#c4a87a;font-size:12px;margin:0 0 4px;">Ottawa, Ontario &middot; harryspottercleaning.ca</p>
      <p style="color:#8a6a50;font-size:11px;margin:0;">Quote ID: ${quote.id.slice(0, 8)}</p>
    </div>

  </div>
</body>
</html>`;
}

// ── Route Registration ────────────────────────────────────────────────────────
export async function registerRoutes(_httpServer: Server, app: Express) {

  // ── Internal: 24h client reminder emails ──────────────────────────────────
  // POST /api/internal/send-client-reminder            (reminder_type='initial')
  // POST /api/internal/send-client-reminder-update     (reminder_type='update')
  // Both guarded by X-Internal-Secret, called from the Supabase cron / Edge
  // Function on harryspottercleaning.ca.
  attachReminderEndpoints(app, () => ({
    supabase: hsSupa,
    resend,
    internalSecret: process.env.INTERNAL_SERVICE_SECRET || "",
  }));

  // ── Logo asset ────────────────────────────────────────────────────────────
  app.get("/api/assets/logo", (_req, res) => {
    const logoPath = path.resolve(__dirname, "public", "harry-spotter-logo.jpg");
    if (fs.existsSync(logoPath)) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.sendFile(logoPath);
    } else {
      res.status(404).send("Logo not found");
    }
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  app.get("/api/settings", async (_req, res) => {
    try {
      const s = await getStorage().getSettings();
      res.json(s);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/settings", requireAuth, async (req, res) => {
    try {
      const s = await getStorage().upsertSettings(req.body);
      res.json(s);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Promo Codes ───────────────────────────────────────────────────────────
  app.get("/api/promo-codes", async (_req, res) => {
    try {
      res.json(await getStorage().getPromoCodes());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // IMPORTANT: /validate must come before /:id to avoid route shadowing
  app.post("/api/promo-codes/validate", async (req, res) => {
    try {
      const { code } = req.body;
      const pc = await getStorage().getPromoCode(code);
      if (!pc || !pc.active) return res.status(404).json({ error: "Invalid or inactive promo code" });
      const now = new Date();
      if (pc.validFrom && new Date(pc.validFrom) > now) return res.status(400).json({ error: "Promo not yet valid" });
      if (pc.validTo   && new Date(pc.validTo)   < now) return res.status(400).json({ error: "Promo has expired" });
      res.json(pc);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/promo-codes", requireAuth, async (req, res) => {
    try {
      const { code, type, value, active, validFrom, validTo } = req.body;
      const pc = await getStorage().createPromoCode({
        code: code.toUpperCase(),
        type,
        value,
        active: active ?? true,
        validFrom: validFrom || null,
        validTo: validTo || null,
      });
      res.status(201).json(pc);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/promo-codes/:id", async (req, res) => {
    try {
      const pc = await getStorage().updatePromoCode(req.params.id, req.body);
      if (!pc) return res.status(404).json({ error: "Not found" });
      res.json(pc);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/promo-codes/:id", async (req, res) => {
    try {
      await getStorage().deletePromoCode(req.params.id);
      res.status(204).send();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Email Signups (CASL consent audit) ─────────────────────────────────────
  // Append-only log — records every time a user ticks a consent checkbox or
  // submits the promo popup. Captures IP + UA from the request.
  // Public by design (anonymous signup). Rate-limit by IP (50/min).
  // TODO: swap the in-memory counter for Redis before we scale out horizontally.
  app.post("/api/email-signups", ipRateLimit({ max: 50, windowMs: 60_000 }), async (req, res) => {
    try {
      const parsed = emailSignupRequestSchema.parse(req.body);
      const ip =
        (req.headers["x-forwarded-for"] as string || "").split(",")[0].trim() ||
        req.ip ||
        req.socket?.remoteAddress ||
        null;
      const ua = (req.headers["user-agent"] as string) || null;

      const row = await getStorage().createEmailSignup({
        email: parsed.email,
        source: parsed.source,
        consentText: parsed.consentText,
        ipAddress: ip,
        userAgent: ua,
        bookingId: parsed.bookingId ?? null,
      });
      res.status(201).json({ id: row.id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Clients ───────────────────────────────────────────────────────────────
  app.get("/api/clients", async (_req, res) => {
    try {
      res.json(await getStorage().getClients());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Quotes ────────────────────────────────────────────────────────────────
  app.get("/api/quotes", async (_req, res) => {
    try {
      const db = getStorage();
      const qs = await db.getQuotes();
      // Auto-expire overdue sent quotes
      const now = new Date();
      const updated = await Promise.all(
        qs.map(async q => {
          if (q.status === "sent" && new Date(q.expiresAt) < now) {
            return (await db.updateQuoteStatus(q.id, "expired")) ?? q;
          }
          return q;
        })
      );
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/quotes/:id", async (req, res) => {
    try {
      const db = getStorage();
      const q = await db.getQuote(req.params.id);
      if (!q) return res.status(404).json({ error: "Not found" });
      const [items, client] = await Promise.all([
        db.getQuoteItems(q.id),
        db.getClient(q.clientId),
      ]);
      res.json({ quote: q, items, client });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create quote — full flow: upsert client + create quote + line items
  app.post("/api/quotes", async (req, res) => {
    try {
      const form = quoteFormSchema.parse(req.body);
      const db   = getStorage();
      const s    = await db.getSettings();

      if (!s) {
        return res.status(500).json({ error: "Pricing settings not found. Run the Supabase seed SQL first." });
      }

      // Upsert client by email
      const allClients = await db.getClients();
      let client = allClients.find(c => c.email === form.email);
      if (!client) {
        client = await db.createClient({
          name:    form.name,
          email:   form.email,
          phone:   form.phone,
          address: form.address,
        });
      }

      // Pricing — new per-service engine (non-stacking discount, discount only on portion above minimum)
      const sessions = form.numberOfSessions ?? 1;
      const multiEligibleRaw = sessions >= 2;

      // Validate promo code. A code is "welcome-eligible" if it exists, is active,
      // and is a percent-type discount (we treat any active percent code as a welcome-style 15% promo).
      let welcomeEligibleRaw = false;
      let usedPromo: string | null = null;
      if (form.promoCode) {
        const pc = await db.getPromoCode(form.promoCode);
        if (pc && pc.active) {
          welcomeEligibleRaw = true;
          usedPromo = pc.code;
        }
      }

      // ── Email consent gate (CASL) ───────────────────────────────────────────
      // Every discount (Welcome, Multi-Booking, any future promo) requires
      // recorded CASL consent. Re-validate server-side; never trust the
      // frontend alone. If consent is missing, strip discount eligibility.
      let consentVerified = false;
      if (form.emailConsentId) {
        const signup = await db.getEmailSignup(form.emailConsentId);
        if (signup && signup.email.toLowerCase() === form.email.toLowerCase()) {
          consentVerified = true;
        }
      }
      if (!consentVerified && form.emailConsent === true) {
        // Client declared consent without a prior signup row — record it now.
        const source = form.emailConsentSource ?? "inline_checkbox";
        const consentText = form.emailConsentText ??
          "Email me promotional offers from Harry Spotter Cleaning Co. Unsubscribe anytime.";
        const ip =
          (req.headers["x-forwarded-for"] as string || "").split(",")[0].trim() ||
          req.ip ||
          req.socket?.remoteAddress ||
          null;
        const ua = (req.headers["user-agent"] as string) || null;
        try {
          await db.createEmailSignup({
            email: form.email,
            source,
            consentText,
            ipAddress: ip,
            userAgent: ua,
          });
          consentVerified = true;
        } catch (e: any) {
          console.error("[consent] Failed to record inline consent:", e?.message);
        }
      }
      if (!consentVerified) {
        const hasPrior = await db.hasEmailSignup(form.email).catch(() => false);
        if (hasPrior) consentVerified = true;
      }

      // Discount eligibility is gated on verified consent. If there is no
      // consent on file, strip eligibility so the quote is generated at
      // full price.
      const multiEligible   = consentVerified && multiEligibleRaw;
      const welcomeEligible = consentVerified && welcomeEligibleRaw;
      if (!consentVerified) {
        // Drop the promo code so it is not recorded as "applied" on a full-price quote.
        usedPromo = null;
      }

      const pricing = computePricing({
        serviceType: form.serviceType,
        squareFootage: form.squareFootage,
        addons: form.addons || [],
        sessions,
        discountCode: usedPromo,
        welcomeEligible,
        multiEligible,
        settings: s,
      });

      // Multiply by number of sessions (each session is its own clean at same price)
      const perSessionSubtotal = pricing.subtotal;
      const perSessionHst = pricing.hst;
      const subtotal = round2(perSessionSubtotal * sessions);
      const tax = round2(perSessionHst * sessions);
      const afterDiscount = subtotal;
      const discount = round2(pricing.discount * sessions);
      const total = round2(subtotal + tax);

      // Build line items scaled by sessions
      const rawItems = pricing.lineItems.map(i => ({
        ...i,
        lineTotal: round2(i.lineTotal * sessions),
        quantity: i.quantity === 1 ? 1 : i.quantity * sessions,
      }));
      if (sessions > 1) {
        rawItems.unshift({ label: `× ${sessions} cleaning sessions`, quantity: sessions, unitPrice: 0, lineTotal: 0, category: "sessions" });
      }

      // Combine entrance method into special notes for storage
      const notesWithEntrance = [form.specialNotes, form.entranceMethod ? `Entrance method: ${form.entranceMethod}` : ""].filter(Boolean).join("\n");

      const quote = await db.createQuote({
        clientId:     client.id,
        subtotal,
        discount,
        total,
        currency:     "CAD",
        promoCode:    usedPromo,
        status:       "draft",
        propertyType: form.propertyType,
        squareFootage: form.squareFootage,
        bedrooms:     form.bedrooms,
        bathrooms:    form.bathrooms,
        specialNotes: notesWithEntrance,
        services:     JSON.stringify([form.serviceType]),
        addons:       JSON.stringify(form.addons),
      });

      // Add tax as a line item for display
      const taxItem = { label: `HST (13%)`, quantity: 1, unitPrice: tax, lineTotal: tax, category: "tax" };
      const allItems = [...rawItems, taxItem];
      const items = await db.createQuoteItems(allItems.map(i => ({ ...i, quoteId: quote.id })));

      // Check if oven/laundry add-ons were selected for notices
      const hasOven = (form.addons || []).includes("oven");
      const hasLaundry = (form.addons || []).includes("laundry");

      // Structured breakdown for UI
      const breakdown = {
        serviceType: pricing.serviceType,
        minimum:     pricing.minimum,
        sqftRate:    pricing.sqftRate,
        sqftPrice:   round2(pricing.sqftPrice * sessions),
        basePrice:   round2(pricing.basePrice * sessions),
        discountablePortion: round2(pricing.discountablePortion * sessions),
        discountPct: pricing.discountPct,
        discountLabel: pricing.discountLabel,
        discountedBase: round2(pricing.discountedBase * sessions),
        addOnsTotal: round2(pricing.addOnsTotal * sessions),
        addons:      rawItems.filter(i => i.category === "addon").map(i => ({ label: i.label, amount: i.lineTotal })),
        numberOfSessions: sessions,
        multiDiscount: pricing.discountLabel === "Multi-Booking (20%)" ? discount : 0,
        promoDiscount: pricing.discountLabel === "Welcome (15%)" ? discount : 0,
        subtotal,
        discount,
        afterDiscount,
        tax,
        taxRate:   HST_RATE,
        total,
        hasOven,
        ovenNotice: hasOven ? OVEN_NOTICE : null,
        hasLaundry,
        laundryNotice: hasLaundry ? LAUNDRY_NOTICE : null,
      };

      res.status(201).json({ quote: { ...quote, total }, items, client, breakdown });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/quotes/:id/status", async (req, res) => {
    try {
      const q = await getStorage().updateQuoteStatus(req.params.id, req.body.status);
      if (!q) return res.status(404).json({ error: "Not found" });
      res.json(q);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Accept quote — called from the email "Accept" button link
  app.get("/api/quotes/:id/accept", async (req, res) => {
    try {
      const db = getStorage();
      const q  = await db.getQuote(req.params.id);
      if (!q)                      return res.status(404).send("Quote not found.");
      if (q.status === "expired")  return res.status(410).send("This quote has expired.");
      if (q.status === "accepted") {
        return res.send(acceptedHtml("You already accepted this quote. We'll be in touch shortly."));
      }
      await db.updateQuoteStatus(q.id, "accepted");

      // Notify business owner
      if (resend) {
        try {
          const client = await db.getClient(q.clientId);
          const items  = await db.getQuoteItems(q.id);
          const linesSummary = items.map(i => `${i.label}: $${i.lineTotal.toFixed(2)}`).join("<br>");
          await resend.emails.send({
            from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
            to:      "magic@harryspottercleaning.ca",
            subject: `✅ Quote Accepted — ${client?.name} ($${q.total.toFixed(2)} CAD)`,
            html: `
              <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px;">
                <h2 style="color:#01696f;margin:0 0 16px;">Quote Accepted</h2>
                <p><strong>${client?.name}</strong> has accepted their quote.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                  <tr><td style="padding:6px 0;color:#555;">Email</td><td><a href="mailto:${client?.email}">${client?.email}</a></td></tr>
                  <tr><td style="padding:6px 0;color:#555;">Phone</td><td>${client?.phone || "—"}</td></tr>
                  <tr><td style="padding:6px 0;color:#555;">Address</td><td>${client?.address || "—"}</td></tr>
                  <tr><td style="padding:6px 0;color:#555;">Service</td><td>${q.propertyType}</td></tr>
                  <tr><td style="padding:6px 0;color:#555;">Sq Ft (areas cleaned)</td><td>${q.squareFootage}</td></tr>
                  <tr><td style="padding:6px 0;color:#555;">Total</td><td><strong>$${q.total.toFixed(2)} CAD</strong></td></tr>
                </table>
                <p style="color:#555;font-size:13px;">Line items:<br>${linesSummary}</p>
              </div>
            `,
          });
        } catch (emailErr) {
          console.error("[notify] Failed to send owner notification:", emailErr);
        }
      }

      res.send(acceptedHtml("Thank you! We'll be in touch to confirm your appointment."));
    } catch (err: any) {
      res.status(500).send("An error occurred.");
    }
  });

  // Send quote email
  app.post("/api/quotes/:id/send", async (req, res) => {
    try {
      const db     = getStorage();
      const q      = await db.getQuote(req.params.id);
      if (!q) return res.status(404).json({ error: "Not found" });

      const client = await db.getClient(q.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });

      const items   = await db.getQuoteItems(q.id);
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
      const html    = buildEmailHtml(client, q, items, baseUrl);

      if (!resend) {
        console.log(`[DEV] Email would be sent to ${client.email} for quote ${q.id}`);
        await db.updateQuoteStatus(q.id, "sent");
        return res.json({ success: true, dev: true, message: "Dev mode: email logged, quote marked as sent." });
      }

      await resend.emails.send({
        from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
        to:      client.email,
        subject: `Your Cleaning Quote from Harry Spotter Cleaning Co. — $${q.total.toFixed(2)} CAD`,
        html,
      });

      await db.updateQuoteStatus(q.id, "sent");
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Email preview
  app.get("/api/quotes/:id/email-preview", async (req, res) => {
    try {
      const db     = getStorage();
      const q      = await db.getQuote(req.params.id);
      if (!q) return res.status(404).json({ error: "Not found" });
      const client = await db.getClient(q.clientId);
      if (!client) return res.status(404).json({ error: "Client not found" });
      const items  = await db.getQuoteItems(q.id);
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const html = buildEmailHtml(client, q, items, baseUrl);
      res.setHeader("Content-Type", "text/html");
      res.send(html);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Booking routes ──────────────────────────────────────────────────────────

  // GET /api/booking/slots — returns available time slots for the next 2 weeks
  app.get("/api/booking/slots", async (_req, res) => {
    try {
      const slots = await getAvailableSlots();
      res.json(slots);
    } catch (err: any) {
      console.error("[booking] Failed to get slots:", err.message);
      res.status(500).json({ error: "Could not load available slots." });
    }
  });

  // POST /api/payment/intent — create a Stripe PaymentIntent for a quote
  // Public by design — anonymous clients submit quotes before creating an account.
  // Instead of JWT auth, we check the supplied `customerEmail` matches the quote's
  // client email: a quote-ownership guard that stops a leaked quoteId from being
  // weaponised against a different client's email.
  app.post("/api/payment/intent", async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Payments not configured." });
      const { quoteId, customerEmail } = req.body;
      if (!quoteId) return res.status(400).json({ error: "quoteId required." });

      const db = getStorage();
      const q  = await db.getQuote(quoteId);
      if (!q) return res.status(404).json({ error: "Quote not found." });

      if (customerEmail) {
        const client = await db.getClient(q.clientId);
        if (!client || client.email.toLowerCase() !== String(customerEmail).toLowerCase()) {
          return res.status(403).json({ error: "Quote does not belong to this email." });
        }
      }

      const total = q.total;
      const amountCents = Math.round(total * 100);
      const intent = await stripe.paymentIntents.create({
        amount:   amountCents,
        currency: "cad",
        capture_method: "automatic",  // capture payment immediately at booking
        metadata: { quoteId: q.id },
        description: `Harry Spotter — Quote ${q.id.slice(0, 8)}`,
      });

      res.json({ clientSecret: intent.client_secret, amount: total });
    } catch (err: any) {
      console.error("[stripe] PaymentIntent error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/booking/book — client books a slot for a quote
  app.post("/api/booking/book", requireAuth, async (req, res) => {
    try {
      const { quoteId, start, end, paymentIntentId } = req.body;
      const bodySlots = Array.isArray(req.body?.slots) ? (req.body.slots as SlotInput[]) : null;
      const slotInputs: SlotInput[] = bodySlots && bodySlots.length > 0
        ? bodySlots
        : (start && end ? [{ start, end }] : []);

      if (!quoteId || slotInputs.length === 0) {
        return res.status(400).json({ error: "quoteId and at least one slot (slots[] or start/end) are required." });
      }

      const db     = getStorage();
      const q      = await db.getQuote(quoteId);
      if (!q) return res.status(404).json({ error: "Quote not found." });
      const client = await db.getClient(q.clientId);
      if (!client) return res.status(404).json({ error: "Client not found." });

      // ── Fix 4: re-validate 48h buffer + slot availability against the live
      // Google Calendar feed. Client-side checks are not trusted.
      const validation = await validateBookingSlots(slotInputs);
      if (!validation.ok) {
        const err = validation.err;
        if (err.kind === "buffer_violation") {
          return res.status(400).json({ error: "buffer_violation", detail: err.reason, slot: err.slot });
        }
        if (err.kind === "slot_unavailable") {
          return res.status(409).json({ error: "slot_unavailable", detail: err.reason, slot: err.slot });
        }
        return res.status(400).json({ error: err.kind, detail: err.reason });
      }
      const validSlots = validation.slots;

      // Create one Google Calendar event per slot.
      const calendarResults: Array<{ start: string; end: string; eventLink: string }> = [];
      for (const s of validSlots) {
        const link = await bookSlot({
          start:         s.start,
          end:           s.end,
          clientName:    client.name,
          clientEmail:   client.email,
          clientPhone:   client.phone || "",
          clientAddress: client.address || "",
          serviceType:   q.propertyType,
          total:         q.total,
          quoteId:       q.id,
        });
        calendarResults.push({ start: s.start, end: s.end, eventLink: link });
      }

      // ── Fix 5: write a row per slot to the Supabase jobs table + generate
      // a booking reference code. Without this, the contractor pipeline never
      // starts and the calendar UI keeps offering the same slot.
      const bookingRef = generateBookingReference();
      const jobIds: string[] = [];
      if (hsSupa) {
        let serviceTypeForJob: string = "standard";
        try {
          const sArr = JSON.parse(q.services || "[]");
          if (Array.isArray(sArr) && typeof sArr[0] === "string") serviceTypeForJob = sArr[0];
        } catch {}
        const flatPayout = getContractorPayout(serviceTypeForJob);
        for (let i = 0; i < validSlots.length; i++) {
          const s = validSlots[i];
          const eventLink = calendarResults[i]?.eventLink || "";
          const notes = [
            `Booking ref: ${bookingRef}${validSlots.length > 1 ? ` (session ${i + 1}/${validSlots.length})` : ""}`,
            `Quote: ${q.id}`,
            client.email ? `Client email: ${client.email}` : "",
            client.phone ? `Phone: ${client.phone}` : "",
            q.squareFootage ? `Sqft: ${q.squareFootage}` : "",
            eventLink ? `Calendar: ${eventLink}` : "",
          ].filter(Boolean).join("\n");
          const { data: jobRow, error: jobErr } = await hsSupa.from("jobs").insert({
            client_name:     client.name,
            client_address:  client.address || "",
            city:            (client as any).city || "",
            service_type:    serviceTypeForJob,
            scheduled_start: s.start,
            scheduled_end:   s.end,
            pay_amount:      flatPayout,
            notes,
            status:          "open",
            quote_id:        q.id,
          }).select("id").single();
          if (jobErr) {
            console.error("[booking] Failed to insert job row:", jobErr.message);
          } else if (jobRow?.id) {
            jobIds.push(jobRow.id);
          }
        }

        // Kick off the notify-contractors chain for the first job (fan-out
        // handled server-side; idempotent by (job_id, contractor_id) unique).
        if (jobIds.length > 0 && process.env.SUPABASE_FUNCTIONS_URL && process.env.INTERNAL_SERVICE_SECRET) {
          try {
            await fetch(`${process.env.SUPABASE_FUNCTIONS_URL}/notify-contractors`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Internal-Secret": process.env.INTERNAL_SERVICE_SECRET,
              },
              body: JSON.stringify({ jobId: jobIds[0] }),
            });
          } catch (e) {
            console.error("[booking] notify-contractors kickoff failed:", e);
          }
        }
      }

      const primarySlot = validSlots[0];
      const eventLink = calendarResults[0]?.eventLink || "";

            // Update to accepted, store Stripe PaymentIntent ID, and fire cascade
      await db.updateQuoteStatus(q.id, "accepted", { paymentIntentId: paymentIntentId || null });

      // Cascade auto-assignment DISABLED — owner controls contractor assignment manually.
      // triggerCascadeAssignment({ ... });

      // Notify owner
      if (resend) {
        const items = await db.getQuoteItems(q.id);
        const slotLabel = new Date(primarySlot.start).toLocaleString("en-CA", {
          timeZone: "America/Toronto",
          weekday: "long", month: "long", day: "numeric",
          hour: "numeric", minute: "2-digit", hour12: true,
        });
        const linesSummary = items.map(i => `${i.label}: $${i.lineTotal.toFixed(2)}`).join("<br>");
        await resend.emails.send({
          from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
          to:      "magic@harryspottercleaning.ca",
          subject: `✅ Booking Confirmed — ${client.name} on ${slotLabel}`,
          html: `
            <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px;">
              <h2 style="color:#01696f;margin:0 0 16px;">New Booking Confirmed</h2>
              <p><strong>${client.name}</strong> has accepted their quote and booked a slot.</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <tr><td style="padding:6px 0;color:#555;">Date & Time</td><td><strong>${slotLabel}</strong></td></tr>
                <tr><td style="padding:6px 0;color:#555;">Email</td><td><a href="mailto:${client.email}">${client.email}</a></td></tr>
                <tr><td style="padding:6px 0;color:#555;">Phone</td><td>${client.phone || "—"}</td></tr>
                <tr><td style="padding:6px 0;color:#555;">Address</td><td>${client.address || "—"}</td></tr>
                <tr><td style="padding:6px 0;color:#555;">Service</td><td>${q.propertyType}</td></tr>
                <tr><td style="padding:6px 0;color:#555;">Total</td><td><strong>$${q.total.toFixed(2)} CAD</strong></td></tr>
              </table>
              <p style="color:#555;font-size:13px;">Line items:<br>${linesSummary}</p>
              ${eventLink ? `<p><a href="${eventLink}" style="color:#01696f;">View in Google Calendar →</a></p>` : ""}
            </div>
          `,
        }).catch(e => console.error("[booking] Owner notify failed:", e));

        // Send confirmation email to client — full branded receipt
        const receiptItemRows = items.map(i =>
          `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #f0ece8;color:#5a4a3a;font-size:14px;">${i.label}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #f0ece8;color:#3d2b1f;font-size:14px;text-align:right;">$${i.lineTotal.toFixed(2)}</td>
          </tr>`
        ).join("");

        // Parse the services JSON for a readable label
        let serviceLabel = q.propertyType || "Cleaning";
        try {
          const sArr = JSON.parse(q.services || "[]");
          if (sArr.length > 0) {
            const sMap: Record<string, string> = { standard: "Standard Clean", deep: "Deep Clean", moveout: "Move-In / Move-Out" };
            serviceLabel = sMap[sArr[0]] || sArr[0];
          }
        } catch {}

        await resend.emails.send({
          from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
          to:      client.email,
          subject: `📅 Your Cleaning is Booked — ${slotLabel}`,
          html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Booking Confirmation &amp; Receipt</title></head>
<body style="margin:0;padding:0;background:#fdf8f0;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(110,22,41,0.12);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#6b1629 0%,#a01733 60%,#78420e 100%);padding:32px 40px;text-align:center;">
      <h1 style="color:#f9bc15;margin:0;font-size:24px;font-weight:800;letter-spacing:0.5px;">Harry Spotter Cleaning Co.</h1>
      <p style="color:#fde68a;margin:6px 0 0;font-size:13px;letter-spacing:0.5px;">Ottawa's Magical Cleaning Team</p>
    </div>

    <!-- Body -->
    <div style="padding:36px 40px;">
      <h2 style="color:#6b1629;font-size:22px;margin:0 0 6px;">Hi ${client.name}, you're booked! ✨</h2>
      <p style="color:#5a4a3a;font-size:15px;margin:0 0 24px;line-height:1.6;">Here's your booking confirmation and receipt for your records.</p>

      <!-- Appointment card -->
      <div style="background:#fdf2f4;border:2px solid #f4a3b2;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
        <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#a01733;font-weight:700;">Appointment Details</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:5px 0;color:#7a7974;font-size:14px;width:120px;">Date &amp; Time</td><td style="color:#3d2b1f;font-size:14px;font-weight:700;">${slotLabel}</td></tr>
          <tr><td style="padding:5px 0;color:#7a7974;font-size:14px;">Address</td><td style="color:#3d2b1f;font-size:14px;">${client.address || "—"}</td></tr>
          <tr><td style="padding:5px 0;color:#7a7974;font-size:14px;">Package</td><td style="color:#3d2b1f;font-size:14px;">${serviceLabel}</td></tr>
          <tr><td style="padding:5px 0;color:#7a7974;font-size:14px;">Property</td><td style="color:#3d2b1f;font-size:14px;">${q.squareFootage ? q.squareFootage + ' sq ft' : ''} ${q.propertyType || ''}</td></tr>
        </table>
      </div>

      <!-- Itemized receipt -->
      <p style="margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#a01733;font-weight:700;">Itemized Receipt</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <thead>
          <tr style="background:#fdf2f4;">
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#7e162c;font-weight:700;border-bottom:2px solid #f4a3b2;text-transform:uppercase;letter-spacing:0.5px;">Item</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#7e162c;font-weight:700;border-bottom:2px solid #f4a3b2;text-transform:uppercase;letter-spacing:0.5px;">Amount</th>
          </tr>
        </thead>
        <tbody>${receiptItemRows}</tbody>
      </table>

      ${q.discount > 0 ? `
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <tr>
          <td style="color:#5a4a3a;font-size:14px;padding:4px 0;">Subtotal</td>
          <td style="color:#3d2b1f;font-size:14px;text-align:right;">$${q.subtotal.toFixed(2)} CAD</td>
        </tr>
        <tr>
          <td style="color:#166534;font-size:14px;padding:4px 0;">Discount${q.promoCode ? ` (${q.promoCode})` : ''}</td>
          <td style="color:#166534;font-size:14px;text-align:right;">-$${q.discount.toFixed(2)} CAD</td>
        </tr>
      </table>` : ""}

      ${items.some((i: any) => i.label === "In-Oven Cleaning") ? `
      <div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
        <p style="margin:0;color:#92400e;font-size:12px;line-height:1.5;"><strong>&#9888;&#65039; Oven Cleaning Notice:</strong> Easy-Off is used for deep oven cleaning. This product emits a strong odour. We recommend opening windows for ventilation during and after the service.</p>
      </div>` : ""}

      ${items.some((i: any) => i.label === "Laundry Wash & Fold") ? `
      <div style="background:#eff6ff;border:1px solid #3b82f6;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
        <p style="margin:0;color:#1e40af;font-size:12px;line-height:1.5;"><strong>&#128085; Laundry Notice:</strong> Client is responsible for sorting special care items (delicates, dry-clean-only, etc.) before the service and for putting laundry away after completion.</p>
      </div>` : ""}

      <!-- Total -->
      <div style="background:linear-gradient(135deg,#fdf2f4,#fff8e6);border:2px solid #f4a3b2;border-radius:12px;padding:18px 20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="font-size:16px;font-weight:700;color:#3d2b1f;">Total Charged (incl. HST)</td>
            <td style="font-size:24px;font-weight:800;color:#a01733;text-align:right;">$${q.total.toFixed(2)} <span style="font-size:13px;font-weight:600;color:#7a6550;">CAD</span></td>
          </tr>
        </table>
      </div>

      <!-- Payment confirmation -->
      <div style="text-align:center;margin-bottom:20px;">
        <span style="display:inline-block;background:#f0fdf4;border:1px solid #86efac;border-radius:50px;padding:6px 16px;font-size:12px;color:#166534;font-weight:600;">&#10003; Payment Confirmed &mdash; Keep this email as your receipt</span>
      </div>

      <!-- Notes -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
        <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#475569;">Please Note</p>
        <ul style="margin:0;padding-left:16px;font-size:12px;color:#64748b;line-height:1.7;">
          <li>Your cleaning specialist provides all cleaning solutions, broom, mop, and vacuum.</li>
          <li>For sanitary reasons, the client must supply their own toilet brush.</li>
          <li>To cancel or reschedule, please contact us at least 24 hours before your appointment for a full refund.</li>
        </ul>
      </div>

      <p style="color:#7a7974;font-size:13px;margin:0 0 8px;">Questions? Call us at <a href="tel:3433216242" style="color:#a01733;font-weight:600;">343-321-6242</a> or reply to this email.</p>
    </div>

    <!-- Footer -->
    <div style="padding:20px 40px;background:linear-gradient(135deg,#4a0f1c,#3d0c16);border-top:3px solid #f9bc15;text-align:center;">
      <p style="color:#fde68a;font-size:13px;font-weight:600;margin:0 0 4px;">Harry Spotter Cleaning Co.</p>
      <p style="color:#c4a87a;font-size:12px;margin:0 0 4px;">Ottawa, Ontario &middot; harryspottercleaning.ca</p>
      <p style="color:#8a6a50;font-size:11px;margin:0;">Booking Reference: ${bookingRef}</p>
    </div>

  </div>
</body>
</html>`,
        }).catch(e => console.error("[booking] Client confirm email failed:", e));
      }

      res.json({
        success: true,
        bookingReference: bookingRef,
        eventLink,
        slots: validSlots.map((s, i) => ({
          start:     s.start,
          end:       s.end,
          label:     s.label,
          eventLink: calendarResults[i]?.eventLink || "",
          jobId:     jobIds[i] || null,
        })),
        total: q.total,
        serviceType: q.propertyType,
      });
    } catch (err: any) {
      console.error("[booking] Failed to book slot:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cascade/decline — contractor declines a mission; triggers next in cascade
  app.get("/api/cascade/decline", async (req, res) => {
    const { quoteId, cid } = req.query as { quoteId?: string; cid?: string };
    if (!quoteId || !cid) {
      return res.status(400).send("<p>Invalid decline link.</p>");
    }
    if (!hsSupa) {
      return res.status(503).send("<p>Cascade service unavailable.</p>");
    }
    try {
      // Mark this assignment as declined
      const { data: declinedAssignment } = await hsSupa
        .from("job_cascade_assignments")
        .update({ status: "declined", declined_at: new Date().toISOString() })
        .eq("quote_id", quoteId)
        .eq("contractor_id", cid)
        .eq("status", "pending")
        .select("cascade_position")
        .single();

      const nextPosition = (declinedAssignment?.cascade_position ?? 1) + 1;

      const { data: contractors } = await hsSupa
        .from("contractor_applications")
        .select("id, full_name, email")
        .eq("status", "approved")
        .order("cascade_order", { ascending: true });

      // Check if we've exhausted all contractors
      if (!contractors || nextPosition > contractors.length) {
        // Cancel the Stripe auth hold — full refund since no contractor available
        const db = getStorage();
        const q  = await db.getQuote(quoteId);
        if (q && (q as any).paymentIntentId && stripe) {
          try {
            await stripe.paymentIntents.cancel((q as any).paymentIntentId);
            console.log(`[cascade] Cancelled PaymentIntent ${(q as any).paymentIntentId} — no contractors available`);
          } catch (cancelErr: any) {
            console.error(`[cascade] Failed to cancel PaymentIntent:`, cancelErr?.message);
          }
        }

        // Notify owner — nobody left
        if (resend) {
          const client = q ? await db.getClient(q.clientId) : null;
          await resend.emails.send({
            from: process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
            to:   "magic@harryspottercleaning.ca",
            subject: `⚠️ All contractors declined — Quote #${quoteId}`,
            html: `<p>All contractors have declined or timed out for quote <strong>${quoteId}</strong>. The payment authorization has been automatically cancelled (full refund).${client ? ` Client: ${client.name} (${client.email})` : ''}</p>`,
          }).catch(console.error);

          // Notify client of the refund
          if (client) {
            await resend.emails.send({
              from: process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
              to:   client.email,
              subject: `Update on Your Cleaning Booking — Harry Spotter Cleaning Co.`,
              html: `<div style="font-family:'Segoe UI',sans-serif;max-width:560px;margin:32px auto;">
                <div style="background:linear-gradient(135deg,#6b1629,#a01733);padding:24px 32px;border-radius:12px 12px 0 0;text-align:center;">
                  <h1 style="color:#f9bc15;margin:0;font-size:20px;">Harry Spotter Cleaning Co.</h1>
                </div>
                <div style="background:#fff;padding:28px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
                  <p>Hi ${client.name},</p>
                  <p>Unfortunately, we were unable to assign a cleaning specialist for your requested time slot. Your payment authorization has been <strong>fully cancelled</strong> — no charge will appear on your card.</p>
                  <p>We sincerely apologize for the inconvenience. Please feel free to book again at a different time, or call us at <a href="tel:3433216242">343-321-6242</a> and we’ll help you find an available slot.</p>
                  <p style="color:#7a7974;font-size:13px;margin-top:24px;">Harry Spotter Cleaning Co. · harryspottercleaning.ca</p>
                </div>
              </div>`,
            }).catch(console.error);
          }
        }
        return res.send(`<!DOCTYPE html><html><head><title>Declined</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;">
          <h2>Got it — thanks for letting us know.</h2><p>This job has been returned to the team for re-assignment.</p>
        </body></html>`);
      }

      // Get quote details + job start time for the next email
      const db = getStorage();
      const q  = await db.getQuote(quoteId);
      if (!q) return res.status(404).send("Quote not found.");
      const client = await db.getClient(q.clientId);

      // Look up scheduled_start from the jobs table (linked by quote_id)
      const { data: jobRow } = await hsSupa
        .from("jobs")
        .select("scheduled_start")
        .eq("quote_id", quoteId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      // Pick next contractor (position is 1-indexed, array is 0-indexed)
      const nextContractor = contractors[(nextPosition - 1) % contractors.length];

      const baseUrl    = process.env.BASE_URL || "https://api.harryspottercleaning.ca";
      const startStr   = jobRow?.scheduled_start ?? new Date(Date.now() + 86400000).toISOString();
      const hoursAway  = (new Date(startStr).getTime() - Date.now()) / 36e5;
      const windowMins = hoursAway >= 24 ? 120 : 30;
      const expiresAt  = new Date(Date.now() + windowMins * 60 * 1000).toISOString();

      await hsSupa.from("job_cascade_assignments").insert({
        quote_id:         quoteId,
        contractor_id:    nextContractor.id,
        expires_at:       expiresAt,
        status:           "pending",
        cascade_position: nextPosition,
      });

      const slotLabel = new Date(startStr).toLocaleString("en-CA", {
        timeZone: "America/Toronto", weekday: "long", month: "long",
        day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
      });
      const acceptUrl  = `https://harryspottercleaning.ca/contractor?action=accept&jobId=${quoteId}&cid=${nextContractor.id}`;
      const declineUrl = `${baseUrl}/api/cascade/decline?quoteId=${quoteId}&cid=${nextContractor.id}`;

      if (resend) {
        await resend.emails.send({
          from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
          to:      nextContractor.email,
          subject: `✨ New Mission — ${slotLabel}`,
          html: buildContractorMissionEmail({
            contractorName: nextContractor.full_name,
            slotLabel,
            clientAddr:     client?.address || "",
            total:          q.total,
            windowMins,
            acceptUrl,
            declineUrl,
            logoUrl: `${baseUrl}/api/assets/logo`,
          }),
        }).catch(console.error);
      }

      res.send(`<!DOCTYPE html><html><head><title>Declined</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>Got it — thanks for letting us know.</h2><p>The job has been offered to the next available specialist.</p>
      </body></html>`);
    } catch (err: any) {
      console.error("[cascade/decline] error:", err?.message || err);
      res.status(500).send("<p>Something went wrong. Please contact the team.</p>");
    }
  });

  // GET /api/quotes/:id/book — booking page served as HTML (linked from quote email)
  app.get("/api/quotes/:id/book", async (req, res) => {
    try {
      const db     = getStorage();
      const q      = await db.getQuote(req.params.id);
      if (!q) return res.status(404).send("Quote not found.");
      if (q.status === "accepted") return res.send(bookingDoneHtml("You already have a booking confirmed. We'll see you soon!"));
      if (q.status === "expired")  return res.status(410).send("This quote has expired.");

      const client  = await db.getClient(q.clientId);
      const slots   = await getAvailableSlots();
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;

      res.setHeader("Content-Type", "text/html");
      res.send(buildBookingHtml(q, client?.name || "there", slots, baseUrl));
    } catch (err: any) {
      console.error("[booking-page] error:", err?.message || err, err?.stack);
      res.status(500).send("An error occurred loading the booking page.");
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Stripe Connect — Contractor payout onboarding
  // ══════════════════════════════════════════════════════════════════════════════

  // POST /api/stripe/connect/create — Create a Stripe Connect account for the
  // authenticated contractor. Never trusts a client-supplied contractorId —
  // the contractor row is resolved from req.user.email (Supabase JWT).
  app.post("/api/stripe/connect/create", requireAuth, async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
      if (!hsSupa) return res.status(503).json({ error: "Supabase not configured" });
      const callerEmail = req.user!.email.toLowerCase();

      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id, full_name, email, stripe_account_id")
        .ilike("email", callerEmail)
        .maybeSingle();
      if (cErr) return res.status(500).json({ error: cErr.message });
      if (!contractor) return res.status(403).json({ error: "No contractor application for this user" });

      // If a Stripe account already exists for this contractor, reuse it —
      // never create a second one on retry.
      if (contractor.stripe_account_id) {
        return res.json({ accountId: contractor.stripe_account_id, reused: true });
      }

      const fullName = contractor.full_name || "";
      const account = await stripe.accounts.create({
        type: "express",
        country: "CA",
        email: contractor.email,
        business_type: "individual",
        individual: {
          first_name: fullName.split(" ")[0] || "",
          last_name:  fullName.split(" ").slice(1).join(" ") || "",
          email:      contractor.email,
        },
        capabilities: {
          card_payments: { requested: false },
          transfers:     { requested: true },
        },
        business_profile: {
          mcc: "7349",
          product_description: "Residential cleaning services for Harry Spotter Cleaning Co.",
        },
        metadata: { contractorId: contractor.id },
      });

      // Server is the only writer of stripe_account_id — the client no longer
      // writes this column directly from PayoutSetup.tsx.
      await hsSupa
        .from("contractor_applications")
        .update({ stripe_account_id: account.id })
        .eq("id", contractor.id);

      console.log(`[stripe-connect] Created account ${account.id} for contractor ${contractor.id}`);
      res.json({ accountId: account.id });
    } catch (err: any) {
      console.error("[stripe-connect] Create error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/stripe/connect/onboard-link — Get a Stripe onboarding link.
  // Always resolves the accountId from the caller's contractor row — never
  // from the request body.
  app.post("/api/stripe/connect/onboard-link", requireAuth, async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
      if (!hsSupa) return res.status(503).json({ error: "Supabase not configured" });
      const callerEmail = req.user!.email.toLowerCase();

      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id, stripe_account_id")
        .ilike("email", callerEmail)
        .maybeSingle();
      if (cErr) return res.status(500).json({ error: cErr.message });
      if (!contractor || !contractor.stripe_account_id) {
        return res.status(400).json({ error: "No Stripe account for this contractor" });
      }

      const returnUrl  = `https://harryspottercleaning.ca/contractor?stripe=complete&cid=${contractor.id}`;
      const refreshUrl = `https://harryspottercleaning.ca/contractor?stripe=refresh&cid=${contractor.id}`;

      const link = await stripe.accountLinks.create({
        account: contractor.stripe_account_id,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      });

      res.json({ url: link.url });
    } catch (err: any) {
      console.error("[stripe-connect] Onboard link error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/stripe/connect/status/:accountId — Check onboarding status
  app.get("/api/stripe/connect/status/:accountId", async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
      const account = await stripe.accounts.retrieve(req.params.accountId);

      res.json({
        accountId: account.id,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
        requirementsDue: account.requirements?.currently_due || [],
        onboardingComplete: account.details_submitted && account.payouts_enabled,
      });
    } catch (err: any) {
      console.error("[stripe-connect] Status error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Stripe Identity — Government ID + selfie verification
  // Platform pays all verification costs. Harry Spotter never stores
  // the ID image itself — only the verified name/DOB/status from Stripe.
  // ══════════════════════════════════════════════════════════════

  // POST /api/identity/create-session — Create a Stripe Identity VerificationSession
  // Returns the hosted verification URL the contractor is redirected to.
  app.post("/api/identity/create-session", requireAuth, async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
      if (!hsSupa) return res.status(503).json({ error: "Supabase not configured" });
      const { contractorId } = req.body || {};
      if (!contractorId) return res.status(400).json({ error: "contractorId required" });

      // Look up contractor to get email + name for Stripe metadata
      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id, full_name, email, identity_verification_id, identity_status")
        .eq("id", contractorId)
        .single();
      if (cErr || !contractor) {
        return res.status(404).json({ error: "Contractor not found" });
      }

      // If already verified, short-circuit
      if (contractor.identity_status === "verified") {
        return res.json({ alreadyVerified: true, status: "verified" });
      }

      // If a session already exists and is still usable, reuse it
      if (contractor.identity_verification_id) {
        try {
          const existing = await stripe.identity.verificationSessions.retrieve(
            contractor.identity_verification_id,
          );
          if (existing.status === "requires_input" && existing.url) {
            return res.json({
              verificationSessionId: existing.id,
              url: existing.url,
              status: existing.status,
              reused: true,
            });
          }
        } catch {
          // Fall through and create a new one
        }
      }

      const returnUrl = `https://harryspottercleaning.ca/contractor?identity=complete&cid=${contractorId}`;

      const session = await stripe.identity.verificationSessions.create({
        type: "document",
        options: {
          document: {
            require_matching_selfie: true,
            require_live_capture: true,
            allowed_types: ["driving_license", "passport", "id_card"],
          },
        },
        metadata: {
          contractor_id: contractorId,
          contractor_email: contractor.email,
          platform: "harry_spotter_cleaning",
        },
        return_url: returnUrl,
      });

      await hsSupa
        .from("contractor_applications")
        .update({
          identity_verification_id: session.id,
          identity_status: "pending",
          identity_last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", contractorId);

      console.log(
        `[stripe-identity] Created VerificationSession ${session.id} for contractor ${contractorId}`,
      );

      res.json({
        verificationSessionId: session.id,
        url: session.url,
        status: session.status,
      });
    } catch (err: any) {
      console.error("[stripe-identity] Create error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/identity/status/:contractorId — Latest identity status for portal UI
  app.get("/api/identity/status/:contractorId", async (req, res) => {
    try {
      if (!hsSupa) return res.status(503).json({ error: "Supabase not configured" });
      const { data, error } = await hsSupa
        .from("contractor_applications")
        .select(
          "identity_verification_id, identity_status, identity_verified_at, identity_verified_name, identity_last_error",
        )
        .eq("id", req.params.contractorId)
        .single();
      if (error || !data) return res.status(404).json({ error: "Not found" });
      res.json({
        verificationSessionId: data.identity_verification_id,
        status: data.identity_status,
        verifiedAt: data.identity_verified_at,
        verifiedName: data.identity_verified_name,
        lastError: data.identity_last_error,
      });
    } catch (err: any) {
      console.error("[stripe-identity] Status error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/identity/check-prc-name — Fuzzy-match contractor-provided PRC name vs Stripe-verified name
  // Called by the frontend right after the PRC file is uploaded.
  // Writes prc_name_match + prc_name_match_score. Does NOT block — admin reviews mismatches.
  app.post("/api/identity/check-prc-name", requireAuth, async (req, res) => {
    try {
      if (!hsSupa) return res.status(503).json({ error: "Supabase not configured" });
      const { contractorId, prcName } = req.body || {};
      if (!contractorId || !prcName) {
        return res.status(400).json({ error: "contractorId and prcName required" });
      }

      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id, identity_status, identity_verified_name")
        .eq("id", contractorId)
        .single();
      if (cErr || !contractor) return res.status(404).json({ error: "Contractor not found" });

      if (contractor.identity_status !== "verified" || !contractor.identity_verified_name) {
        await hsSupa
          .from("contractor_applications")
          .update({ prc_name_match: "no_identity", prc_name_match_score: null })
          .eq("id", contractorId);
        return res.json({ match: "no_identity", score: null, reason: "Identity not verified yet" });
      }

      const score = fuzzyNameScore(contractor.identity_verified_name, prcName);
      const match: "match" | "mismatch" = score >= 0.82 ? "match" : "mismatch";

      await hsSupa
        .from("contractor_applications")
        .update({ prc_name_match: match, prc_name_match_score: score })
        .eq("id", contractorId);

      console.log(
        `[stripe-identity] PRC name check for ${contractorId}: "${contractor.identity_verified_name}" vs "${prcName}" = ${match} (${score.toFixed(3)})`,
      );

      res.json({
        match,
        score,
        identityName: contractor.identity_verified_name,
        prcName,
      });
    } catch (err: any) {
      console.error("[stripe-identity] PRC name check error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/identity/sync/:contractorId — Manually pull latest verification state from Stripe
  // Use this if a webhook is missed/failed. Idempotent — safe to call repeatedly.
  app.post("/api/identity/sync/:contractorId", requireAuth, async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
      if (!hsSupa) return res.status(503).json({ error: "Supabase not configured" });
      const { contractorId } = req.params;

      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id, full_name, identity_verification_id")
        .eq("id", contractorId)
        .single();
      if (cErr || !contractor) return res.status(404).json({ error: "Contractor not found" });
      if (!contractor.identity_verification_id) {
        return res.status(400).json({ error: "No verification session for this contractor" });
      }

      const session = await stripe.identity.verificationSessions.retrieve(
        contractor.identity_verification_id,
        { expand: ["verified_outputs"] } as any,
      );

      const vo: any = (session as any).verified_outputs;
      let verifiedName: string | null = null;
      let verifiedDob: string | null = null;
      if (vo) {
        const first = vo.first_name ?? "";
        const last = vo.last_name ?? "";
        verifiedName = `${first} ${last}`.trim() || null;
        if (vo.dob && vo.dob.year && vo.dob.month && vo.dob.day) {
          const mm = String(vo.dob.month).padStart(2, "0");
          const dd = String(vo.dob.day).padStart(2, "0");
          verifiedDob = `${vo.dob.year}-${mm}-${dd}`;
        }
      }

      let newStatus:
        | "pending"
        | "verified"
        | "requires_input"
        | "canceled"
        | "failed" = "pending";
      switch (session.status) {
        case "verified":
          newStatus = "verified";
          break;
        case "requires_input":
          newStatus = "requires_input";
          break;
        case "canceled":
          newStatus = "canceled";
          break;
        case "processing":
          newStatus = "pending";
          break;
        default:
          newStatus = "pending";
      }

      const lastError = (session.last_error as any)?.reason || (session.last_error as any)?.code || null;
      const updateFields: Record<string, any> = {
        identity_status: newStatus,
        identity_last_error: lastError,
        updated_at: new Date().toISOString(),
      };
      if (newStatus === "verified") {
        updateFields.identity_verified_at = new Date().toISOString();
        if (verifiedName) updateFields.identity_verified_name = verifiedName;
        if (verifiedDob) updateFields.identity_verified_dob = verifiedDob;
      }

      const { error: updErr } = await hsSupa
        .from("contractor_applications")
        .update(updateFields)
        .eq("id", contractorId);
      if (updErr) return res.status(500).json({ error: updErr.message });

      await hsSupa.from("identity_verifications").insert({
        contractor_id: contractorId,
        stripe_verification_session_id: session.id,
        event_type: "manual_sync",
        status: newStatus,
        verified_name: verifiedName,
        verified_dob: verifiedDob,
        last_error: lastError,
        raw_event: { source: "manual_sync", session_status: session.status } as any,
      });

      // Re-run PRC name match if now verified
      if (newStatus === "verified" && verifiedName && contractor.full_name) {
        const score = fuzzyNameScore(verifiedName, contractor.full_name);
        const matchFlag: "match" | "mismatch" = score >= 0.82 ? "match" : "mismatch";
        await hsSupa
          .from("contractor_applications")
          .update({ prc_name_match: matchFlag, prc_name_match_score: score })
          .eq("id", contractorId);
      }

      console.log(
        `[stripe-identity] Manual sync for ${contractorId}: stripe_status=${session.status}, new_db_status=${newStatus}, verified_name=${verifiedName}`,
      );

      res.json({
        contractorId,
        stripeStatus: session.status,
        dbStatus: newStatus,
        verifiedName,
        verifiedDob,
        lastError,
      });
    } catch (err: any) {
      console.error("[stripe-identity] Sync error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/identity/webhook — Stripe Identity webhook handler
  // Configure this URL in Stripe Dashboard → Developers → Webhooks.
  // Subscribe to: identity.verification_session.verified,
  //               identity.verification_session.requires_input,
  //               identity.verification_session.canceled,
  //               identity.verification_session.processing
  app.post("/api/identity/webhook", async (req, res) => {
    if (!stripe) return res.status(503).json({ error: "Stripe not configured" });
    if (!hsSupa) return res.status(503).json({ error: "Supabase not configured" });

    const sig = req.headers["stripe-signature"] as string | undefined;
    const secret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET || "";
    if (!sig || !secret) {
      console.error("[stripe-identity] Missing signature or webhook secret");
      return res.status(400).send("Missing signature or secret");
    }

    let event: Stripe.Event;
    try {
      const raw = (req as any).rawBody;
      event = stripe.webhooks.constructEvent(raw, sig, secret);
    } catch (err: any) {
      console.error("[stripe-identity] Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      const session = event.data.object as Stripe.Identity.VerificationSession;
      const contractorId = (session.metadata as any)?.contractor_id as string | undefined;
      if (!contractorId) {
        console.warn("[stripe-identity] Webhook event missing contractor_id metadata", event.type);
        return res.json({ received: true, warning: "no contractor_id" });
      }

      // Fetch verified outputs (only available on .verified events — for others, session.verified_outputs is null)
      let verifiedName: string | null = null;
      let verifiedDob: string | null = null; // YYYY-MM-DD
      if (event.type === "identity.verification_session.verified") {
        // Need the full session with verified_outputs expanded
        const full = await stripe.identity.verificationSessions.retrieve(session.id, {
          expand: ["verified_outputs"],
        } as any);
        const vo: any = (full as any).verified_outputs;
        if (vo) {
          const first = vo.first_name ?? "";
          const last = vo.last_name ?? "";
          verifiedName = `${first} ${last}`.trim() || null;
          if (vo.dob && vo.dob.year && vo.dob.month && vo.dob.day) {
            const mm = String(vo.dob.month).padStart(2, "0");
            const dd = String(vo.dob.day).padStart(2, "0");
            verifiedDob = `${vo.dob.year}-${mm}-${dd}`;
          }
        }
      }

      let newStatus:
        | "pending"
        | "verified"
        | "requires_input"
        | "canceled"
        | "failed" = "pending";
      switch (event.type) {
        case "identity.verification_session.verified":
          newStatus = "verified";
          break;
        case "identity.verification_session.requires_input":
          newStatus = "requires_input";
          break;
        case "identity.verification_session.canceled":
          newStatus = "canceled";
          break;
        case "identity.verification_session.processing":
          newStatus = "pending";
          break;
        default:
          console.log(`[stripe-identity] Ignoring event ${event.type}`);
          return res.json({ received: true, ignored: event.type });
      }

      const lastError = (session.last_error as any)?.reason || (session.last_error as any)?.code || null;

      const updateFields: Record<string, any> = {
        identity_status: newStatus,
        identity_last_error: lastError,
        updated_at: new Date().toISOString(),
      };
      if (newStatus === "verified") {
        updateFields.identity_verified_at = new Date().toISOString();
        if (verifiedName) updateFields.identity_verified_name = verifiedName;
        if (verifiedDob) updateFields.identity_verified_dob = verifiedDob;
      }

      const { error: updErr } = await hsSupa
        .from("contractor_applications")
        .update(updateFields)
        .eq("id", contractorId);
      if (updErr) {
        console.error("[stripe-identity] Update failed:", updErr.message);
        return res.status(500).json({ error: updErr.message });
      }

      // Audit log
      await hsSupa.from("identity_verifications").insert({
        contractor_id: contractorId,
        stripe_verification_session_id: session.id,
        event_type: event.type,
        status: newStatus,
        verified_name: verifiedName,
        verified_dob: verifiedDob,
        last_error: lastError,
        raw_event: event as any,
      });

      // If identity just verified and a PRC filename was previously stored, re-check name match
      if (newStatus === "verified" && verifiedName) {
        const { data: full } = await hsSupa
          .from("contractor_applications")
          .select("full_name")
          .eq("id", contractorId)
          .single();
        if (full?.full_name) {
          const score = fuzzyNameScore(verifiedName, full.full_name);
          const matchFlag: "match" | "mismatch" = score >= 0.82 ? "match" : "mismatch";
          await hsSupa
            .from("contractor_applications")
            .update({ prc_name_match: matchFlag, prc_name_match_score: score })
            .eq("id", contractorId);
        }
      }

      console.log(
        `[stripe-identity] Webhook ${event.type} → contractor ${contractorId} status=${newStatus}`,
      );
      res.json({ received: true });
    } catch (err: any) {
      console.error("[stripe-identity] Webhook handler error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // ══════════════════════════════════════════════════════════════════════════════
  // POST /api/job/complete — Job-complete pipeline
  //   1. Capture Stripe auth hold (manual PaymentIntent)
  //   2. Update job status in Harry Spotter Supabase
  //   3. Send thank-you email to client
  //   4. If client hasn't booked another job → generate 7-day discount code & include
  // ══════════════════════════════════════════════════════════════════════════════
  // Accept either a valid Supabase JWT OR an X-Internal-Secret header for
  // server-to-server calls from the Supabase `complete-job` Edge Function.
  app.post("/api/job/complete", requireAuthOrInternal, async (req, res) => {
    try {
      const { jobId, contractorId } = req.body;
      if (!jobId) return res.status(400).json({ error: "jobId is required." });

      // ── Step 1: Get job details from Harry Spotter Supabase (if available) ──
      let quoteId: string | null = null;
      const now = new Date().toISOString();

      if (hsSupa) {
        const { data: job } = await hsSupa
          .from("jobs")
          .select("quote_id")
          .eq("id", jobId)
          .single();
        if (job) quoteId = job.quote_id;
      }

      // ── Step 2: Get the quote & client from Clean Wizz Supabase ──
      const db = getStorage();
      let clientEmail = "";
      let clientName  = "";
      let paymentIntentId: string | null = null;
      let quoteTotal = 0;

      if (quoteId) {
        const q = await db.getQuote(quoteId);
        if (q) {
          paymentIntentId = (q as any).paymentIntentId || null;
          quoteTotal = q.total;
          const client = await db.getClient(q.clientId);
          if (client) {
            clientEmail = client.email;
            clientName  = client.name;
          }
        }
      }

      // ── Step 3: Payment already captured at booking. Transfer payout to
      // contractor via Stripe Connect. This is the ONLY place payouts are
      // created — the Supabase Edge Function `process-payouts` no longer
      // invents `sent` rows without a real Stripe transfer.
      let transferResult: any = null;
      let payoutStatus: "sent" | "failed" | "skipped" = "skipped";
      let payoutError: string | null = null;
      let payAmount = 0;
      if (stripe && contractorId && hsSupa) {
        const { data: ctr } = await hsSupa
          .from("contractor_applications")
          .select("stripe_account_id, pay_amount")
          .eq("id", contractorId)
          .single();

        let serviceType: string | null = null;
        const { data: jobData } = await hsSupa.from("jobs").select("service_type, pay_amount").eq("id", jobId).single();
        if (jobData?.service_type) {
          serviceType = jobData.service_type;
          payAmount = getContractorPayout(jobData.service_type);
        } else if (jobData?.pay_amount) {
          payAmount = Number(jobData.pay_amount);
        }
        if (serviceType && payAmount > 0) {
          await hsSupa.from("jobs").update({ pay_amount: payAmount }).eq("id", jobId);
        }

        if (ctr?.stripe_account_id && payAmount > 0) {
          try {
            transferResult = await stripe.transfers.create({
              amount: Math.round(payAmount * 100), // cents
              currency: "cad",
              destination: ctr.stripe_account_id,
              description: `Payout for job ${jobId.slice(0, 8)}`,
              metadata: { jobId, contractorId },
            });
            payoutStatus = "sent";
            console.log(`[job-complete] Transferred $${payAmount.toFixed(2)} to ${ctr.stripe_account_id}`);
          } catch (transferErr: any) {
            payoutStatus = "failed";
            payoutError = transferErr?.message || String(transferErr);
            console.error(`[job-complete] Transfer error: ${payoutError}`);
          }
        } else {
          payoutError = !ctr?.stripe_account_id
            ? "No Stripe Connect account"
            : "No pay_amount resolved";
          console.log(`[job-complete] Skipped Stripe transfer: ${payoutError}`);
        }

        // Record the result in the payouts table. Never mark `sent` without
        // a real Stripe transfer response.
        if (payoutStatus === "sent" && transferResult) {
          await hsSupa.from("payouts").upsert(
            buildPayoutRecord({
              jobId,
              contractorId,
              amount: payAmount,
              now,
              transferId: transferResult.id,
              error: null,
            }),
            { onConflict: "job_id" } as any,
          );
        } else if (payoutStatus === "failed") {
          await hsSupa.from("payouts").upsert(
            buildPayoutRecord({
              jobId,
              contractorId,
              amount: payAmount,
              now,
              transferId: null,
              error: payoutError,
            }),
            { onConflict: "job_id" } as any,
          );
        }
      }

      // ── Step 5: Check if client is a returning customer ──
      let isReturning = false;
      let discountCode = "";
      let discountExpiry = "";

      if (clientEmail) {
        // Count how many accepted quotes this client email has
        const allClients = await db.getClients();
        const clientsByEmail = allClients.filter(
          (c: any) => c.email.toLowerCase() === clientEmail.toLowerCase()
        );
        const clientIds = clientsByEmail.map((c: any) => c.id);

        // Check quotes for those client IDs
        const allQuotes = await db.getQuotes();
        const acceptedQuotes = allQuotes.filter(
          (q: any) => clientIds.includes(q.clientId) && q.status === "accepted"
        );

        isReturning = acceptedQuotes.length > 1; // More than just this booking

        // If not returning → generate a one-time discount code (7-day expiry)
        if (!isReturning) {
          const code = `COMEBACK${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
          const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          discountCode = code;
          discountExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", {
            timeZone: "America/Toronto",
            weekday: "long",
            month: "long",
            day: "numeric",
          });

          // Save the discount code in promo_codes table
          try {
            await db.createPromoCode({
              code,
              type: "percent",
              value: 15,
              active: true,
              validFrom: now,
              validTo: expiresAt,
            });
            console.log(`[job-complete] Created comeback discount code: ${code} (15% off, expires ${expiresAt})`);
          } catch (promoErr: any) {
            console.error(`[job-complete] Failed to create promo code: ${promoErr.message}`);
          }
        }
      }

      // ── Step 6: Send thank-you email ──
      if (resend && clientEmail) {
        const thankYouSubject = isReturning
          ? `✨ Thank you for choosing Harry Spotter again, ${clientName}!`
          : `✨ Thank you for choosing Harry Spotter, ${clientName}!`;

        let discountHtml = "";
        if (!isReturning && discountCode) {
          discountHtml = `
            <div style="background:linear-gradient(135deg,#2d1854,#5b21b6);border-radius:12px;padding:24px;margin:24px 0;text-align:center;">
              <p style="color:#ffd03e;font-size:18px;font-weight:700;margin:0 0 8px;">🪄 A Little Magic for Your Next Clean</p>
              <p style="color:#e9d5ff;font-size:14px;margin:0 0 16px;">Use this exclusive code for <strong>15% off</strong> your next booking:</p>
              <div style="background:#ffd03e;color:#2d1854;font-size:24px;font-weight:800;letter-spacing:3px;padding:12px 24px;border-radius:8px;display:inline-block;">
                ${discountCode}
              </div>
              <p style="color:#c4b5fd;font-size:12px;margin:12px 0 0;">Valid until ${discountExpiry} — one-time use</p>
            </div>`;
        }

        const thankYouHtml = `
          <div style="font-family:'Segoe UI','Nunito',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#fdf8f0;">
            <div style="text-align:center;margin-bottom:24px;">
              <img src="https://harryspottercleaning.ca/Completed_Trasp_Logo_for_Harry_Spotter.png" alt="Harry Spotter" width="80" style="border-radius:12px;" />
            </div>
            <h1 style="color:#6b1629;font-size:22px;text-align:center;margin:0 0 8px;">Thank You${clientName ? `, ${clientName}` : ''}! ✨</h1>
            <p style="color:#555;font-size:15px;text-align:center;margin:0 0 24px;">
              Your home has been given the Harry Spotter treatment and we hope it sparkles!
            </p>
            <div style="background:#fff;border:1px solid #e5e2db;border-radius:12px;padding:20px;margin-bottom:16px;">
              <p style="color:#333;font-size:14px;margin:0 0 8px;"><strong>What's next?</strong></p>
              <ul style="color:#555;font-size:14px;margin:0;padding-left:20px;">
                <li>Your payment has been processed</li>
                <li>If you have any concerns about the service, please reach out within 24 hours</li>
              </ul>
            </div>
            <div style="background:linear-gradient(135deg,#fef9e7,#fff8e1);border:2px solid #ffd03e;border-radius:12px;padding:24px;margin:16px 0;text-align:center;">
              <p style="font-size:28px;margin:0 0 8px;">⭐⭐⭐⭐⭐</p>
              <p style="color:#6b1629;font-size:16px;font-weight:700;margin:0 0 8px;">Loved your clean? Leave us a review!</p>
              <p style="color:#555;font-size:13px;margin:0 0 16px;">Your feedback helps other Ottawa homeowners discover our magical cleaning service. It only takes 30 seconds!</p>
              <a href="${process.env.GOOGLE_REVIEW_URL || 'https://g.page/r/harryspottercleaning/review'}" style="display:inline-block;background:#ffd03e;color:#6b1629;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:800;font-size:14px;">
                ⭐ Leave a 5-Star Review on Google
              </a>
            </div>
            ${discountHtml}
            <div style="text-align:center;margin-top:24px;">
              <a href="https://harryspottercleaning.ca" style="display:inline-block;background:#a01733;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">
                ${isReturning ? 'Book Your Next Clean' : 'Book Again & Save 15%'}
              </a>
            </div>
            <p style="color:#999;font-size:11px;text-align:center;margin-top:24px;">
              Harry Spotter Cleaning Co. — Ottawa's Magical Cleaners<br/>
              magic@harryspottercleaning.ca | 343-321-6242
            </p>
          </div>`;

        try {
          await resend.emails.send({
            from: process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
            to: clientEmail,
            subject: thankYouSubject,
            html: thankYouHtml,
          });
          console.log(`[job-complete] Thank-you email sent to ${clientEmail}`);
        } catch (emailErr: any) {
          console.error(`[job-complete] Email send error: ${emailErr.message}`);
        }
      }

      // ── Step 7: Notify owner ──
      if (resend) {
        const contractorLabel = contractorId || "unknown";
        await resend.emails.send({
          from: process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
          to: "magic@harryspottercleaning.ca",
          subject: `✅ Job Completed — ${clientName || 'Client'} (Job ${jobId.slice(0, 8)})`,
          html: `<div style="font-family:sans-serif;padding:24px;">
            <h2 style="color:#01696f;">Job Completed</h2>
            <p><strong>Client:</strong> ${clientName || 'N/A'} (${clientEmail || 'N/A'})</p>
            <p><strong>Job ID:</strong> ${jobId}</p>
            <p><strong>Contractor:</strong> ${contractorLabel}</p>
            <p><strong>Payment:</strong> ✅ Captured at booking</p>
            <p><strong>Contractor Payout:</strong> ${transferResult ? `✅ $${(transferResult.amount / 100).toFixed(2)} transferred via Stripe Connect` : '⚠️ No Stripe Connect — manual payout needed'}</p>
            <p><strong>Returning Client:</strong> ${isReturning ? 'Yes ↩' : `No — sent 15% discount (${discountCode})`}</p>
            <p><strong>Payout:</strong> Immediate</p>
          </div>`,
        }).catch(console.error);
      }

      res.json({
        success: true,
        jobId,
        captured: true,
        payoutStatus,
        payoutError,
        transferId: transferResult?.id || null,
        emailSent: !!(resend && clientEmail),
        discountCode: discountCode || null,
        isReturning,
      });

    } catch (err: any) {
      console.error("[job-complete] Pipeline error:", err?.message || err, err?.stack);
      res.status(500).json({ error: err.message || "Job completion pipeline failed." });
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function acceptedHtml(message: string) {
  return `<!DOCTYPE html><html><head><title>Quote Accepted</title>
<style>
  body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
       min-height:100vh;background:#f7f6f2;margin:0}
  .card{background:#fff;border-radius:12px;padding:48px;text-align:center;
        box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .icon{font-size:64px}.title{font-size:24px;font-weight:700;color:#28251d;margin:16px 0 8px}
  .sub{color:#7a7974;font-size:16px}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1 class="title">Quote Accepted!</h1>
    <p class="sub">${message}</p>
  </div>
</body></html>`;
}

function bookingDoneHtml(message: string) {
  return `<!DOCTYPE html><html><head><title>Booking Confirmed</title>
<style>
  body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
       min-height:100vh;background:#f7f6f2;margin:0}
  .card{background:#fff;border-radius:12px;padding:48px;text-align:center;
        box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:480px}
  .icon{font-size:64px}.title{font-size:24px;font-weight:700;color:#28251d;margin:16px 0 8px}
  .sub{color:#7a7974;font-size:16px}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">📅</div>
    <h1 class="title">You're Booked!</h1>
    <p class="sub">${message}</p>
  </div>
</body></html>`;
}

function buildBookingHtml(
  quote: any,
  clientName: string,
  slots: SlotInfo[],
  baseUrl: string
) {
  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";
  const logoUrl = `${baseUrl}/api/assets/logo`;
  const slotsJson = JSON.stringify(slots);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Book Your Cleaning — Harry Spotter Cleaning Co.</title>
  <script src="https://js.stripe.com/v3/"><\/script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',sans-serif;background:#1a0a0e;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px}
    .card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 48px rgba(0,0,0,.4);max-width:560px;width:100%}
    /* Header */
    .header{background:linear-gradient(135deg,#7a0e20 0%,#a01733 50%,#7a0e20 100%);padding:0 0 24px;text-align:center;position:relative}
    .header-top{background:rgba(0,0,0,.15);padding:20px 36px 16px;display:flex;align-items:center;justify-content:center;gap:16px}
    .logo-wrap{background:#fff;border-radius:12px;padding:6px 10px;display:inline-flex;align-items:center;justify-content:center}
    .logo-wrap img{height:52px;width:auto;display:block}
    .header-text{text-align:left}
    .header-text h1{color:#f5d878;font-size:20px;font-weight:800;margin:0;letter-spacing:-.01em;text-shadow:0 1px 3px rgba(0,0,0,.3)}
    .header-text p{color:rgba(245,216,120,.75);font-size:12px;margin:2px 0 0;letter-spacing:.02em}
    .header-badge{display:inline-block;background:rgba(245,216,120,.15);border:1px solid rgba(245,216,120,.3);color:#f5d878;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:5px 14px;border-radius:20px;margin:4px 0 0}
    /* Body */
    .body{padding:28px 36px 32px}
    .greeting{font-size:18px;font-weight:700;color:#1a0a0e;margin-bottom:4px}
    .sub{color:#7a7974;font-size:14px;margin-bottom:22px;line-height:1.5}
    .total-badge{background:linear-gradient(135deg,#fdf2f4,#fff8e6);border:1px solid #e8b4be;border-radius:10px;padding:14px 18px;margin-bottom:28px;display:flex;justify-content:space-between;align-items:center}
    .total-badge span{color:#7a7974;font-size:13px;font-weight:500}
    .total-badge strong{color:#a01733;font-size:24px;font-weight:800}
    /* Step labels */
    .step-label{display:flex;align-items:center;gap:8px;margin-bottom:8px}
    .step-num{background:#a01733;color:#fff;width:20px;height:20px;border-radius:50%;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .step-title{font-size:13px;font-weight:700;color:#1a0a0e;letter-spacing:.01em}
    /* Mini calendar */
    .cal-wrap{margin-bottom:16px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}
    .cal-header{display:flex;align-items:center;justify-content:space-between;background:#8B0000;padding:10px 12px}
    .cal-header .cal-month{font-size:15px;font-weight:700;color:#fff}
    .cal-header button{background:none;border:none;width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;color:rgba(255,255,255,.85);transition:color .15s}
    .cal-header button:hover{color:#f5d878}
    .cal-dow-row{display:grid;grid-template-columns:repeat(7,1fr);text-align:center;background:#f7f7f6;border-bottom:1px solid #e5e7eb}
    .cal-dow{font-size:10px;font-weight:700;color:#999;text-transform:uppercase;padding:8px 0;letter-spacing:.04em}
    .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);text-align:center;padding:8px 4px}
    .cal-day{font-size:13px;padding:8px 2px 14px;border-radius:8px;cursor:default;transition:all .15s;border:1.5px solid transparent;font-weight:500;color:#1a0a0e;position:relative}
    .cal-day.cal-clickable{cursor:pointer}
    .cal-day.cal-clickable:hover{background:#fdf2f4;border-color:#e8b4be}
    .cal-day.cal-empty{cursor:default}
    .cal-day.cal-no-slots{color:#ccc}
    .cal-day.cal-has-slots{font-weight:600}
    .cal-day.cal-selected{background:#8B0000;color:#fff;border-color:#8B0000;font-weight:700;border-radius:8px}
    .cal-day.cal-today:not(.cal-selected){font-weight:800;color:#8B0000}
    .cal-dot{position:absolute;bottom:4px;left:50%;transform:translateX(-50%);width:6px;height:6px;border-radius:50%}
    .cal-dot.dot-available{background:#DAA520}
    .cal-dot.dot-none{background:#ccc}
    .cal-legend{display:flex;align-items:center;justify-content:center;gap:16px;padding:8px 0 10px;font-size:11px;color:#888;border-top:1px solid #f0ece8}
    .cal-legend-item{display:flex;align-items:center;gap:5px}
    .cal-legend-dot{width:7px;height:7px;border-radius:50%;display:inline-block}
    .cal-legend-dot.dot-gold{background:#DAA520}
    .cal-legend-dot.dot-grey{background:#ccc}
    /* Slot grid */
    .slots-wrap{margin-top:12px}
    .slots-date-label{font-size:14px;font-weight:700;color:#1a0a0e;margin-bottom:10px;display:flex;align-items:center;gap:6px}
    .slots-date-label::before{content:'\\1F4C5'}
    .slots-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
    .slot-btn{padding:12px 8px;border:1.5px solid #e5e7eb;border-radius:10px;background:#fff;font-size:13px;font-weight:600;color:#1a0a0e;cursor:pointer;transition:all .15s;text-align:center;font-family:inherit;line-height:1.3}
    .slot-btn:hover:not(.slot-disabled){border-color:#8B0000;background:#fdf2f4}
    .slot-btn.slot-selected{background:#8B0000;color:#f5d878;border-color:#8B0000}
    .slot-btn.slot-disabled{background:#f9f9f8;color:#bbb;cursor:not-allowed;border-color:#eee}
    .slot-btn.slot-disabled .slot-time-text{text-decoration:line-through;color:#ccc}
    .slot-btn.slot-disabled .slot-booked-label{display:block;font-size:10px;color:#bbb;margin-top:3px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
    .slot-btn:not(.slot-disabled) .slot-booked-label{display:none}
    .slot-btn:not(.slot-disabled) .slot-time-text{text-decoration:none}
    .slots-empty{font-size:13px;color:#bab9b4;text-align:center;padding:16px 0}
    .divider{border:none;border-top:1px solid #f0ece8;margin:24px 0}
    /* Terms */
    .terms-box{background:#fafaf8;border:1.5px solid #e8e4e0;border-radius:10px;padding:16px 18px;margin-bottom:14px;max-height:210px;overflow-y:auto}
    .terms-box h3{font-size:11px;font-weight:800;color:#a01733;margin-bottom:10px;text-transform:uppercase;letter-spacing:.07em}
    .terms-box .terms-section{margin-bottom:12px}
    .terms-box .terms-section:last-child{margin-bottom:0}
    .terms-box .terms-section h4{font-size:12px;font-weight:700;color:#1a0a0e;margin-bottom:4px}
    .terms-box .terms-section p,.terms-box .terms-section ul{font-size:12px;color:#5a5954;line-height:1.65}
    .terms-box .terms-section ul{padding-left:16px;margin:4px 0 0}
    .terms-box .terms-section ul li{margin-bottom:2px}
    .terms-check{display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:2px 0}
    .terms-check input[type=checkbox]{width:16px;height:16px;flex-shrink:0;margin-top:2px;accent-color:#a01733;cursor:pointer}
    .terms-check span{font-size:13px;color:#1a0a0e;font-weight:600;line-height:1.5}
    /* Stripe */
    .card-section{margin-bottom:4px}
    #card-element{padding:12px 14px;border:1.5px solid #e5e7eb;border-radius:8px;background:#fff;transition:border-color .15s}
    #card-element.StripeElement--focus{border-color:#a01733;box-shadow:0 0 0 3px rgba(160,23,51,.1)}
    #card-element.StripeElement--invalid{border-color:#c0392b}
    #card-errors{color:#c0392b;font-size:12px;margin-top:6px;min-height:18px}
    /* Pay button */
    .btn{display:block;width:100%;margin-top:22px;background:linear-gradient(135deg,#a01733,#7a0e20);color:#f5d878;border:none;padding:16px;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:opacity .15s,transform .1s;letter-spacing:.01em}
    .btn:hover:not(:disabled){opacity:.92;transform:translateY(-1px)}
    .btn:active:not(:disabled){transform:translateY(0)}
    .btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
    .msg{margin-top:16px;padding:14px 16px;border-radius:10px;font-size:14px;text-align:center;display:none;line-height:1.5}
    .msg.success{background:#f0fdf4;color:#166534;border:1px solid #86efac}
    .msg.error{background:#fff0f0;color:#c0392b;border:1px solid #f5c6c6}
    .secure-note{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:10px;color:#bab9b4;font-size:11px}
    .secure-note svg{flex-shrink:0}
    /* Footer */
    .footer{padding:14px 36px;background:#1a0a0e;text-align:center}
    .footer p{color:rgba(245,216,120,.5);font-size:11px}
    .footer a{color:rgba(245,216,120,.7);text-decoration:none}
    .footer a:hover{color:#f5d878}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="header-top">
        <div class="logo-wrap">
          <img src="${logoUrl}" alt="Harry Spotter Cleaning Co." onerror="this.style.display='none'">
        </div>
        <div class="header-text">
          <h1>Harry Spotter Cleaning Co.</h1>
          <p>Professional Cleaning Services &middot; Ontario, Canada</p>
        </div>
      </div>
      <div style="text-align:center;padding:0 36px">
        <div class="header-badge">Booking Confirmation</div>
      </div>
    </div>

    <div class="body">
      <p class="greeting">Hi ${clientName}!</p>
      <p class="sub">You&rsquo;re one step away from locking in your clean. Choose a time, review our service agreement, and complete your payment below.</p>

      <div class="total-badge">
        <span>Amount due today</span>
        <strong>$${quote.total.toFixed(2)} CAD</strong>
      </div>

      ${slots.filter(s => s.status === "available").length === 0
        ? `<p style="color:#c0392b;text-align:center;padding:20px 0;">No available slots right now. Please call us to book directly at <a href="tel:3433216242" style="color:#a01733">343-321-6242</a>.</p>`
        : `
      <!-- Step 1: Time Slot -->
      <div class="step-label">
        <div class="step-num">1</div>
        <div class="step-title">Select a date &amp; time</div>
      </div>
      <div class="cal-wrap" id="calWrap"></div>
      <div class="slots-wrap" id="slotsWrap">
        <p class="slots-empty">Pick a date above to see available times</p>
      </div>
      <input type="hidden" id="slot" value="">


      <hr class="divider">

      <!-- Step 2: Terms & Conditions -->
      <div class="step-label">
        <div class="step-num">2</div>
        <div class="step-title">Service Agreement &amp; Terms</div>
      </div>
      <div class="terms-box">
        <h3>Harry Spotter Cleaning Co. &mdash; Service Agreement</h3>

        <div class="terms-section">
          <h4>Supplies &amp; Access</h4>
          <ul>
            <li>We provide all cleaning supplies, equipment, and products.</li>
            <li>Client must provide a toilet brush for sanitary reasons.</li>
            <li>Client must ensure access to the property at the scheduled time. If we cannot gain entry, the appointment is considered fulfilled.</li>
          </ul>
        </div>

        <div class="terms-section">
          <h4>Payment</h4>
          <p>Full payment is collected at the time of booking. All transactions are processed securely through Stripe. By booking, you authorize Harry Spotter Cleaning Co. to charge the quoted amount to your payment method.</p>
        </div>

        <div class="terms-section">
          <h4>Cancellation Policy</h4>
          <ul>
            <li>Full refund if cancelled 24+ hours before your appointment.</li>
            <li>No refund if cancelled within 24 hours of the appointment time.</li>
            <li>If we cannot access the home at the scheduled time (locked out, no key/code, no entry), the appointment is treated as a late cancellation and is non-refundable.</li>
          </ul>
          <p style="font-size:12px;color:#94a3b8;margin-top:8px;font-style:italic;">This policy ensures fairness, protects our cleaning specialists&rsquo; time, and keeps our scheduling reliable for all clients.</p>
        </div>

        <div class="terms-section">
          <h4>Satisfaction Guarantee</h4>
          <p>If you&rsquo;re not satisfied, contact us within 24 hours. We&rsquo;ll arrange a complimentary reclean within 48 hours. If the issue remains unresolved, a partial or full refund may be issued at our discretion.</p>
        </div>

        <div class="terms-section">
          <h4>Liability</h4>
          <p>Harry Spotter Cleaning Co. is not responsible for pre-existing damage, wear and tear, fragile or unsecured items, or damage caused by concealed hazards. Please secure valuables and fragile items before your appointment. This agreement is governed by the laws of the Province of Ontario, Canada.</p>
        </div>
      </div>

      <label class="terms-check" id="termsLabel">
        <input type="checkbox" id="termsChk">
        <span>I have read and agree to the Service Agreement &amp; Terms above</span>
      </label>

      <hr class="divider">

      <!-- Step 3: Payment -->
      <div class="step-label">
        <div class="step-num">3</div>
        <div class="step-title">Payment details</div>
      </div>
      <div class="card-section">
        <div id="card-element"></div>
        <div id="card-errors" role="alert"></div>
      </div>

      <button class="btn" id="payBtn" disabled>✨ Confirm, Agree &amp; Pay &mdash; $${quote.total.toFixed(2)} CAD</button>
      <div id="totalDisplay" style="text-align:center;font-size:12px;color:#bab9b4;margin-top:6px;"></div>

      <div class="secure-note">
        <svg width="12" height="14" viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="5" width="10" height="8" rx="1.5" fill="#bab9b4"/><path d="M3.5 5V3.5a2.5 2.5 0 0 1 5 0V5" stroke="#bab9b4" stroke-width="1.2" stroke-linecap="round"/></svg>
        Secured by Stripe &middot; Your card details are never stored on our servers
      </div>
      `
      }

      <div class="msg" id="msg"></div>
    </div>

    <div class="footer">
      <p>Harry Spotter Cleaning Co. &middot; Quote #${quote.id.slice(0, 8)} &middot; <a href="https://harryspottercleaning.ca">harryspottercleaning.ca</a></p>
    </div>
  </div>

  <script>
    (function() {
      var PUBLISHABLE_KEY = '${stripePublishableKey}';
      var QUOTE_ID        = '${quote.id}';
      var BASE_URL        = '${baseUrl}';
      var ALL_SLOTS       = ${slotsJson};

      var slotInput    = document.getElementById('slot');
      var termsChk     = document.getElementById('termsChk');
      var payBtn       = document.getElementById('payBtn');
      var msgEl        = document.getElementById('msg');
      var cardErrors   = document.getElementById('card-errors');
      var totalDisplay = document.getElementById('totalDisplay');
      var calWrap      = document.getElementById('calWrap');
      var slotsWrap    = document.getElementById('slotsWrap');
      var baseTotal    = ${quote.total.toFixed(2)};

      if (!payBtn) return;

      if (!PUBLISHABLE_KEY) {
        payBtn.textContent = 'Payment setup in progress \\u2014 please try again shortly';
        payBtn.disabled = true;
        if (cardErrors) cardErrors.textContent = 'Payment is being configured. If this persists, please call us at 343-321-6242.';
        return;
      }

      var stripe      = Stripe(PUBLISHABLE_KEY);
      var elements    = stripe.elements();
      var cardElement = elements.create('card', {
        style: {
          base: {
            fontFamily: "'Segoe UI', sans-serif",
            fontSize: '15px',
            color: '#1a0a0e',
            '::placeholder': { color: '#bab9b4' },
          },
          invalid: { color: '#c0392b' },
        },
      });
      cardElement.mount('#card-element');

      var cardComplete = false;
      var selectedDate = '';
      var selectedSlot = null; // { start, end }

      cardElement.on('change', function(e) {
        cardComplete = e.complete;
        cardErrors.textContent = e.error ? e.error.message : '';
        updatePayBtn();
      });

      function updatePayBtn() {
        payBtn.disabled = !(selectedSlot && termsChk && termsChk.checked && cardComplete);
      }

      if (termsChk) termsChk.addEventListener('change', updatePayBtn);

      // ── Group slots by date ────────────────────────────────────────────────
      var slotsByDate = {};
      ALL_SLOTS.forEach(function(s) {
        if (!slotsByDate[s.date]) slotsByDate[s.date] = [];
        slotsByDate[s.date].push(s);
      });

      // ── Mini calendar rendering ────────────────────────────────────────────
      var viewYear, viewMonth;
      (function initCalView() {
        // Start calendar on the first date that has slots
        var dates = Object.keys(slotsByDate).sort();
        if (dates.length) {
          var p = dates[0].split('-');
          viewYear = parseInt(p[0]); viewMonth = parseInt(p[1]) - 1;
        } else {
          var n = new Date(); viewYear = n.getFullYear(); viewMonth = n.getMonth();
        }
      })();

      function renderCalendar() {
        var today = new Date();
        var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
        var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

        var first = new Date(viewYear, viewMonth, 1);
        var startDow = first.getDay(); // 0=Sun
        var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

        // Crimson header bar
        var h = '<div class="cal-header">';
        h += '<button type="button" id="calPrev">&#8249;</button>';
        h += '<span class="cal-month">' + monthNames[viewMonth] + ' ' + viewYear + '</span>';
        h += '<button type="button" id="calNext">&#8250;</button>';
        h += '</div>';

        // Day-of-week row
        h += '<div class="cal-dow-row">';
        ['SUN','MON','TUE','WED','THU','FRI','SAT'].forEach(function(d){ h += '<div class="cal-dow">' + d + '</div>'; });
        h += '</div>';

        // Date grid
        h += '<div class="cal-grid">';

        // Empty cells before first day
        for (var e = 0; e < startDow; e++) h += '<div class="cal-day cal-empty"></div>';

        for (var d = 1; d <= daysInMonth; d++) {
          var ds = viewYear + '-' + String(viewMonth+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
          var daySlots = slotsByDate[ds] || [];
          var hasAvailable = daySlots.some(function(s){ return s.status === 'available'; });
          var hasAnySlot = daySlots.length > 0;

          var cls = 'cal-day';
          var isClickable = hasAnySlot;
          if (isClickable) cls += ' cal-clickable';
          if (ds === todayStr) cls += ' cal-today';
          if (ds === selectedDate) cls += ' cal-selected';
          else if (hasAvailable) cls += ' cal-has-slots';
          else if (hasAnySlot && !hasAvailable) cls += ' cal-no-slots';
          else if (!hasAnySlot) cls += ' cal-empty';

          h += '<div class="' + cls + '"';
          if (hasAnySlot) h += ' data-date="' + ds + '"';
          h += '>' + d;

          // Dot indicator beneath the number
          if (hasAvailable) {
            h += '<span class="cal-dot dot-available"></span>';
          } else if (hasAnySlot && !hasAvailable) {
            h += '<span class="cal-dot dot-none"></span>';
          }

          h += '</div>';
        }
        h += '</div>';

        // Legend
        h += '<div class="cal-legend">';
        h += '<div class="cal-legend-item"><span class="cal-legend-dot dot-gold"></span> Available</div>';
        h += '<div class="cal-legend-item"><span class="cal-legend-dot dot-grey"></span> No slots</div>';
        h += '</div>';

        calWrap.innerHTML = h;

        // Attach events
        document.getElementById('calPrev').addEventListener('click', function(){ viewMonth--; if(viewMonth<0){viewMonth=11;viewYear--;} renderCalendar(); });
        document.getElementById('calNext').addEventListener('click', function(){ viewMonth++; if(viewMonth>11){viewMonth=0;viewYear++;} renderCalendar(); });

        calWrap.querySelectorAll('.cal-day[data-date]').forEach(function(el) {
          el.addEventListener('click', function() {
            selectedDate = el.getAttribute('data-date');
            selectedSlot = null;
            slotInput.value = '';
            renderCalendar();
            renderSlots();
            updatePayBtn();
          });
        });
      }

      // ── Slot grid rendering ────────────────────────────────────────────────
      function renderSlots() {
        if (!selectedDate) {
          slotsWrap.innerHTML = '<p class="slots-empty">Pick a date above to see available times</p>';
          return;
        }
        var daySlots = slotsByDate[selectedDate] || [];
        if (!daySlots.length) {
          slotsWrap.innerHTML = '<p class="slots-empty">No slots on this date</p>';
          return;
        }

        // Format date for label (e.g., "Thursday, April 16")
        var dp = selectedDate.split('-');
        var dateObj = new Date(parseInt(dp[0]), parseInt(dp[1])-1, parseInt(dp[2]));
        var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        var monthNamesShort = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        var dateLabel = dayNames[dateObj.getDay()] + ', ' + monthNamesShort[dateObj.getMonth()] + ' ' + dateObj.getDate();

        var h = '<div class="slots-date-label">' + dateLabel + '</div><div class="slots-grid">';
        daySlots.forEach(function(s) {
          var isDisabled = s.status !== 'available';
          var isSelected = selectedSlot && selectedSlot.start === s.start;
          var cls = 'slot-btn';
          if (isDisabled) cls += ' slot-disabled';
          if (isSelected) cls += ' slot-selected';

          // Format time label (just the time part)
          var startDate = new Date(s.start);
          var timeLabel = startDate.toLocaleTimeString('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit', hour12: true });

          h += '<button type="button" class="' + cls + '"';
          if (!isDisabled) h += ' data-start="' + s.start + '" data-end="' + s.end + '"';
          h += '><span class="slot-time-text">' + timeLabel + '</span>';
          if (isDisabled) h += '<span class="slot-booked-label">BOOKED</span>';
          h += '</button>';
        });
        h += '</div>';
        slotsWrap.innerHTML = h;

        // Attach slot click events
        slotsWrap.querySelectorAll('.slot-btn:not(.slot-disabled)').forEach(function(btn) {
          btn.addEventListener('click', function() {
            selectedSlot = { start: btn.getAttribute('data-start'), end: btn.getAttribute('data-end') };
            slotInput.value = selectedSlot.start + '|' + selectedSlot.end;
            renderSlots();
            updatePayBtn();
            payBtn.textContent = '\\u2728 Confirm, Agree & Pay \\u2014 $' + baseTotal.toFixed(2) + ' CAD';
          });
        });
      }

      // Initial render
      renderCalendar();

      // ── Payment flow ───────────────────────────────────────────────────────
      payBtn.addEventListener('click', async function() {
        if (!selectedSlot) return;
        var start = selectedSlot.start, end = selectedSlot.end;

        payBtn.disabled = true;
        payBtn.textContent = 'Processing payment\\u2026';
        if (msgEl) msgEl.style.display = 'none';

        try {
          var intentRes = await fetch(BASE_URL + '/api/payment/intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteId: QUOTE_ID, start: start }),
          });
          var intentData = await intentRes.json();
          if (!intentRes.ok) throw new Error(intentData.error || 'Could not create payment.');

          payBtn.textContent = '\\u2728 Confirm, Agree & Pay \\u2014 $' + intentData.amount.toFixed(2) + ' CAD';

          var result = await stripe.confirmCardPayment(intentData.clientSecret, {
            payment_method: { card: cardElement },
          });
          if (result.error) throw new Error(result.error.message);

          payBtn.textContent = 'Confirming booking\\u2026';
          var bookRes = await fetch(BASE_URL + '/api/booking/book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteId: QUOTE_ID, start: start, end: end, paymentIntentId: result.paymentIntent.id }),
          });
          var bookData = await bookRes.json();

          if (bookRes.ok && bookData.success) {
            document.querySelectorAll('.step-label,.divider,.terms-box,#termsLabel,.card-section,.secure-note,#calWrap,#slotsWrap,#totalDisplay').forEach(function(el){ el.style.display='none'; });
            payBtn.style.display = 'none';
            if (msgEl) {
              msgEl.className = 'msg success';
              msgEl.style.display = 'block';
              msgEl.innerHTML = '\\u2728 <strong>You\\'re all booked!</strong> Payment received &mdash; a confirmation email is on its way. We look forward to making your space sparkle!';
            }
          } else {
            throw new Error(bookData.error || 'Booking failed after payment. Please contact us.');
          }
        } catch (err) {
          if (msgEl) {
            msgEl.className = 'msg error';
            msgEl.style.display = 'block';
            msgEl.textContent = err.message || 'Something went wrong. Please try again or call us at 343-321-6242.';
          }
          payBtn.disabled = false;
          payBtn.textContent = '\\u2728 Confirm, Agree & Pay \\u2014 $' + baseTotal.toFixed(2) + ' CAD';
        }
      });
    })();
  <\/script>
</body>
</html>`;
}
