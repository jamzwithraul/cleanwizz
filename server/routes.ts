import type { Express } from "express";
import type { Server } from "http";
import path from "path";
import fs from "fs";
import { getStorage } from "./storage";
import { Resend } from "resend";
import { quoteFormSchema } from "@shared/schema";
import { getAvailableSlots, bookSlot } from "./calendar";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

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
  const isOvernight = (() => { const h = new Date(opts.start).getHours(); return h >= 22 || h < 6; })();

  await resend.emails.send({
    from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
    to:      contractor.email,
    subject: `✨ New Mission${isOvernight ? " (Overnight — Premium Payout)" : ""} — ${slotLabel}`,
    html: buildContractorMissionEmail({
      contractorName: contractor.full_name,
      slotLabel,
      clientAddr:     opts.clientAddr,
      total:          opts.total,
      isOvernight,
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
  isOvernight:    boolean;
  windowMins:     number;
  acceptUrl:      string;
  declineUrl:     string;
  logoUrl:        string;
}) {
  const headerGrad = o.isOvernight
    ? "linear-gradient(135deg,#0f0408 0%,#1a0a0e 50%,#2a0f14 100%)"
    : "linear-gradient(135deg,#6b1629 0%,#a01733 60%,#78420e 100%)";
  const windowLabel = o.windowMins >= 60 ? `${o.windowMins / 60} hour${o.windowMins > 60 ? "s" : ""}` : `${o.windowMins} minutes`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f7f6f2;font-family:'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:32px auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12);">
  <div style="background:${headerGrad};padding:28px 36px;text-align:center;">
    <img src="${o.logoUrl}" alt="Harry Spotter" style="width:72px;height:72px;border-radius:50%;background:#fff;padding:6px;object-fit:contain;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto;">
    <h1 style="color:#f9bc15;margin:0;font-size:22px;font-weight:800;">Harry Spotter Cleaning Co.</h1>
    <p style="color:rgba(249,188,21,.75);margin:4px 0 0;font-size:12px;">${o.isOvernight ? "🌙 Overnight Mission — Premium Payout" : "New Mission Available"}</p>
  </div>
  <div style="background:#fff;padding:28px 36px;">
    <p style="font-size:16px;color:#1a0a0e;margin:0 0 16px;">Hi <strong>${o.contractorName}</strong>,</p>
    <p style="font-size:14px;color:#5a4a3a;margin:0 0 20px;line-height:1.6;">A client has booked a cleaning and you’ve been selected for the mission. ${o.isOvernight ? "This is an <strong>overnight appointment</strong> — it includes a <strong>premium payout</strong> on top of your standard rate." : ""} You have <strong>${windowLabel}</strong> to accept before it’s offered to the next available specialist.</p>
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

// ── Pricing Engine ────────────────────────────────────────────────────────────
function buildLineItems(form: any, s: any) {
  const items: { label: string; quantity: number; unitPrice: number; lineTotal: number }[] = [];

  items.push({ label: "Base rate", quantity: 1, unitPrice: s.baseRate, lineTotal: s.baseRate });

  if (form.squareFootage > 0) {
    const sqftTotal = parseFloat((form.squareFootage * s.pricePerSqft).toFixed(2));
    items.push({
      label: `Square footage (${form.squareFootage} sq ft @ $${s.pricePerSqft}/sq ft)`,
      quantity: form.squareFootage,
      unitPrice: s.pricePerSqft,
      lineTotal: sqftTotal,
    });
  }

  if (form.bedrooms > 0) {
    items.push({ label: `Bedrooms (${form.bedrooms})`, quantity: form.bedrooms, unitPrice: s.perBedroom, lineTotal: form.bedrooms * s.perBedroom });
  }

  if (form.bathrooms > 0) {
    items.push({ label: `Bathrooms (${form.bathrooms})`, quantity: form.bathrooms, unitPrice: s.perBathroom, lineTotal: form.bathrooms * s.perBathroom });
  }

  if (form.serviceType === "deep") {
    items.push({ label: "Deep clean surcharge", quantity: 1, unitPrice: s.deepCleanSurcharge, lineTotal: s.deepCleanSurcharge });
  } else if (form.serviceType === "moveout") {
    items.push({ label: "Move-in/out surcharge", quantity: 1, unitPrice: s.moveoutSurcharge, lineTotal: s.moveoutSurcharge });
  }

  const addonMap: Record<string, { label: string; price: number }> = {
    fridge:     { label: "Inside fridge",     price: s.fridgePrice },
    oven:       { label: "Inside oven",        price: s.ovenPrice },
    windows:    { label: "Interior windows",   price: s.windowsPrice },
    baseboards: { label: "Baseboards",         price: s.baseboardsPrice },
  };
  for (const addon of form.addons || []) {
    const a = addonMap[addon];
    if (a) items.push({ label: a.label, quantity: 1, unitPrice: a.price, lineTotal: a.price });
  }

  return items;
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
          <td style="color:#166534;font-size:14px;padding:4px 0;">Promo (${quote.promoCode})</td>
          <td style="color:#166534;font-size:14px;text-align:right;">-$${quote.discount.toFixed(2)} CAD</td>
        </tr>
      </table>` : ""}

      <!-- Total -->
      <div style="background:linear-gradient(135deg,#fdf2f4,#fff8e6);border:2px solid #f4a3b2;border-radius:12px;padding:18px 20px;margin-bottom:28px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="font-size:18px;font-weight:700;color:#3d2b1f;">Total</td>
            <td style="font-size:28px;font-weight:800;color:#a01733;text-align:right;">$${quote.total.toFixed(2)} <span style="font-size:14px;font-weight:600;color:#7a6550;">CAD</span></td>
          </tr>
        </table>
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

  app.put("/api/settings", async (req, res) => {
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

  app.post("/api/promo-codes", async (req, res) => {
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

      // Pricing
      const rawItems = buildLineItems(form, s);
      const subtotal = rawItems.reduce((sum, i) => sum + i.lineTotal, 0);

      // Promo
      let discount = 0;
      let usedPromo: string | null = null;
      if (form.promoCode) {
        const pc = await db.getPromoCode(form.promoCode);
        if (pc && pc.active) {
          discount = pc.type === "percent"
            ? parseFloat((subtotal * pc.value / 100).toFixed(2))
            : pc.value;
          usedPromo = pc.code;
        }
      }

      const total = parseFloat((subtotal - discount).toFixed(2));

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
        specialNotes: form.specialNotes,
        services:     JSON.stringify([form.serviceType]),
        addons:       JSON.stringify(form.addons),
      });

      const items = await db.createQuoteItems(rawItems.map(i => ({ ...i, quoteId: quote.id })));

      res.status(201).json({ quote, items, client });
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
                  <tr><td style="padding:6px 0;color:#555;">Sq Ft</td><td>${q.squareFootage}</td></tr>
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
  app.post("/api/payment/intent", async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: "Payments not configured." });
      const { quoteId } = req.body;
      if (!quoteId) return res.status(400).json({ error: "quoteId required." });

      const db = getStorage();
      const q  = await db.getQuote(quoteId);
      if (!q) return res.status(404).json({ error: "Quote not found." });

      const amountCents = Math.round(q.total * 100);
      const intent = await stripe.paymentIntents.create({
        amount:   amountCents,
        currency: "cad",
        metadata: { quoteId: q.id },
        description: `Clean Wizz — Quote ${q.id.slice(0, 8)}`,
      });

      res.json({ clientSecret: intent.client_secret, amount: q.total });
    } catch (err: any) {
      console.error("[stripe] PaymentIntent error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/booking/book — client books a slot for a quote
  app.post("/api/booking/book", async (req, res) => {
    try {
      const { quoteId, start, end } = req.body;
      if (!quoteId || !start || !end) {
        return res.status(400).json({ error: "quoteId, start, and end are required." });
      }

      const db     = getStorage();
      const q      = await db.getQuote(quoteId);
      if (!q) return res.status(404).json({ error: "Quote not found." });
      const client = await db.getClient(q.clientId);
      if (!client) return res.status(404).json({ error: "Client not found." });

      // Create Google Calendar event
      const eventLink = await bookSlot({
        start,
        end,
        clientName:    client.name,
        clientEmail:   client.email,
        clientPhone:   client.phone || "",
        clientAddress: client.address || "",
        serviceType: q.propertyType,
        total:         q.total,
        quoteId:       q.id,
      });

      // Update quote status to accepted
      await db.updateQuoteStatus(q.id, "accepted");

      // Auto-assign a contractor via cascade
      triggerCascadeAssignment({
        quoteId:    String(q.id),
        clientName: client.name,
        clientAddr: client.address || "",
        start,
        end,
        total:      q.total,
        baseUrl:    process.env.BASE_URL || "https://api.harryspottercleaning.ca",
      }).catch(e => console.error("[cascade] assignment failed:", e));

      // Notify owner
      if (resend) {
        const items = await db.getQuoteItems(q.id);
        const slotLabel = new Date(start).toLocaleString("en-CA", {
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

        // Send confirmation email to client
        await resend.emails.send({
          from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
          to:      client.email,
          subject: `📅 Your Cleaning is Booked — ${slotLabel}`,
          html: `
            <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:linear-gradient(135deg,#6b1629 0%,#a01733 60%,#78420e 100%);padding:28px 36px;border-radius:12px 12px 0 0;text-align:center;">
                <h1 style="color:#f9bc15;margin:0;font-size:22px;font-weight:800;">Harry Spotter Cleaning Co.</h1>
                <p style="color:#fde68a;margin:4px 0 0;font-size:13px;">Ottawa’s Magical Cleaning Team</p>
              </div>
              <div style="background:#fff;padding:32px 36px;border:1px solid #f4a3b2;border-top:none;border-radius:0 0 12px 12px;">
                <h2 style="color:#6b1629;font-size:20px;margin:0 0 8px;">Hi ${client.name}, you’re booked! ✨</h2>
                <p style="color:#5a4a3a;font-size:15px;margin:0 0 24px;">Here’s a summary of your upcoming cleaning appointment.</p>

                <div style="background:#fdf2f4;border:1px solid #f4a3b2;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
                  <p style="margin:0;font-size:16px;font-weight:700;color:#a01733;">📅 ${slotLabel}</p>
                  <p style="margin:6px 0 0;font-size:14px;color:#7a7974;">${client.address || ""}</p>
                </div>

                <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
                  <tr><td style="padding:6px 0;color:#7a7974;font-size:14px;">Service</td><td style="color:#28251d;font-size:14px;">${q.propertyType}</td></tr>
                  <tr><td style="padding:6px 0;color:#7a7974;font-size:14px;">Total</td><td style="color:#28251d;font-size:14px;font-weight:700;">$${q.total.toFixed(2)} CAD</td></tr>
                </table>

                <p style="color:#7a7974;font-size:13px;margin:0;">Questions? Reply to this email or call us directly. We look forward to seeing you!</p>

                <p style="margin:24px 0 0;font-size:12px;color:#bab9b4;">Harry Spotter Cleaning Co. · quotes@harryspottercleaning.ca</p>
              </div>
            </div>
          `,
        }).catch(e => console.error("[booking] Client confirm email failed:", e));
      }

      res.json({ success: true, eventLink });
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
        // Notify owner — nobody left
        if (resend) {
          await resend.emails.send({
            from: process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
            to:   "magic@harryspottercleaning.ca",
            subject: `⚠️ All contractors declined — Quote #${quoteId}`,
            html: `<p>All contractors have declined or timed out for quote <strong>${quoteId}</strong>. Please assign manually.</p>`,
          }).catch(console.error);
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
      const isOvernight = (() => { const h = new Date(startStr).getHours(); return h >= 22 || h < 6; })();
      const acceptUrl  = `https://harryspottercleaning.ca/contractor?action=accept&jobId=${quoteId}&cid=${nextContractor.id}`;
      const declineUrl = `${baseUrl}/api/cascade/decline?quoteId=${quoteId}&cid=${nextContractor.id}`;

      if (resend) {
        await resend.emails.send({
          from:    process.env.FROM_EMAIL || "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
          to:      nextContractor.email,
          subject: `✨ New Mission${isOvernight ? " (Overnight — Premium Payout)" : ""} — ${slotLabel}`,
          html: buildContractorMissionEmail({
            contractorName: nextContractor.full_name,
            slotLabel,
            clientAddr:     client?.address || "",
            total:          q.total,
            isOvernight,
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
  slots: { start: string; end: string; label: string }[],
  baseUrl: string
) {
  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";
  const logoUrl = `${baseUrl}/api/assets/logo`;
  const slotOptions = slots.map(s =>
    `<option value="${s.start}|${s.end}">${s.label}</option>`
  ).join("\n");

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
    select{width:100%;padding:12px 14px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:15px;color:#1a0a0e;background:#fff;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%237a7974' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;cursor:pointer;font-family:inherit}
    select:focus{outline:none;border-color:#a01733;box-shadow:0 0 0 3px rgba(160,23,51,.1)}
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

      ${slots.length === 0
        ? `<p style="color:#c0392b;text-align:center;padding:20px 0;">No available slots right now. Please call us to book directly at <a href="tel:3433216242" style="color:#a01733">343-321-6242</a>.</p>`
        : `
      <!-- Step 1: Time Slot -->
      <div class="step-label">
        <div class="step-num">1</div>
        <div class="step-title">Select a time slot</div>
      </div>
      <select id="slot">
        <option value="">— Pick a date and time —</option>
        ${slotOptions}
      </select>

      <hr class="divider">

      <!-- Step 2: Terms & Conditions -->
      <div class="step-label">
        <div class="step-num">2</div>
        <div class="step-title">Service Agreement &amp; Terms</div>
      </div>
      <div class="terms-box">
        <h3>Harry Spotter Cleaning Co. &mdash; Service Agreement</h3>

        <div class="terms-section">
          <h4>Payment Policy</h4>
          <p>Full payment is required upfront to confirm your booking and reserve your time slot. All transactions are processed securely through Stripe. By completing your booking, you authorize Harry Spotter Cleaning Co. to charge the full quoted amount to your payment method.</p>
        </div>

        <div class="terms-section">
          <h4>Cancellation &amp; Refund Policy</h4>
          <ul>
            <li><strong>48+ hours before appointment:</strong> Full refund issued.</li>
            <li><strong>24&ndash;48 hours before appointment:</strong> 50% refund issued.</li>
            <li><strong>Less than 24 hours before appointment:</strong> No refund.</li>
            <li><strong>Property access denied:</strong> If our team cannot access the property at the scheduled time, no refund will be issued.</li>
          </ul>
        </div>

        <div class="terms-section">
          <h4>Service Quality Guarantee</h4>
          <ul>
            <li>Any concerns about service quality must be reported within <strong>24 hours</strong> of completion.</li>
            <li>Our first remedy is always a <strong>free reclean</strong>, offered within 24&ndash;48 hours of your report.</li>
            <li>If you decline the reclean, a <strong>partial refund (10&ndash;50%)</strong> may be offered at our discretion.</li>
            <li>A full refund is only issued if the service was not performed or was severely inadequate.</li>
          </ul>
        </div>

        <div class="terms-section">
          <h4>General Terms</h4>
          <ul>
            <li>Booking a service reserves a dedicated cleaning team and time slot exclusively for you.</li>
            <li>Refunds are only considered after a reclean has been offered.</li>
            <li>The Company is not liable for pre-existing damage, fragile items, or unsecured valuables.</li>
            <li>This agreement is governed by the laws of the Province of Ontario, Canada.</li>
          </ul>
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

      var select     = document.getElementById('slot');
      var termsChk   = document.getElementById('termsChk');
      var payBtn     = document.getElementById('payBtn');
      var msgEl      = document.getElementById('msg');
      var cardErrors = document.getElementById('card-errors');

      if (!select || !payBtn) return;

      if (!PUBLISHABLE_KEY) {
        payBtn.textContent = 'Payment setup in progress \u2014 please try again shortly';
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

      cardElement.on('change', function(e) {
        cardComplete = e.complete;
        cardErrors.textContent = e.error ? e.error.message : '';
        updatePayBtn();
      });

      function updatePayBtn() {
        payBtn.disabled = !(select && select.value && termsChk && termsChk.checked && cardComplete);
      }

      select.addEventListener('change', updatePayBtn);
      select.addEventListener('input', updatePayBtn);
      termsChk.addEventListener('change', updatePayBtn);

      payBtn.addEventListener('click', async function() {
        if (!select.value) return;
        var parts = select.value.split('|');
        var start = parts[0], end = parts[1];

        payBtn.disabled = true;
        payBtn.textContent = 'Processing payment\u2026';
        if (msgEl) msgEl.style.display = 'none';

        try {
          var intentRes = await fetch(BASE_URL + '/api/payment/intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteId: QUOTE_ID }),
          });
          var intentData = await intentRes.json();
          if (!intentRes.ok) throw new Error(intentData.error || 'Could not create payment.');

          var result = await stripe.confirmCardPayment(intentData.clientSecret, {
            payment_method: { card: cardElement },
          });
          if (result.error) throw new Error(result.error.message);

          payBtn.textContent = 'Confirming booking\u2026';
          var bookRes = await fetch(BASE_URL + '/api/booking/book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteId: QUOTE_ID, start, end, paymentIntentId: result.paymentIntent.id }),
          });
          var bookData = await bookRes.json();

          if (bookRes.ok && bookData.success) {
            document.querySelectorAll('.step-label,.divider,.terms-box,#termsLabel,.card-section,.secure-note,#slot').forEach(function(el){ el.style.display='none'; });
            payBtn.style.display = 'none';
            if (msgEl) {
              msgEl.className = 'msg success';
              msgEl.style.display = 'block';
              msgEl.innerHTML = '\u2728 <strong>You\'re all booked!</strong> Payment received &mdash; a confirmation email is on its way. We look forward to making your space sparkle!';
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
          payBtn.textContent = '\u2728 Confirm, Agree & Pay \u2014 $${quote.total.toFixed(2)} CAD';
        }
      });
    })();
  <\/script>
</body>
</html>`;
}
