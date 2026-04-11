import type { Express } from "express";
import type { Server } from "http";
import path from "path";
import fs from "fs";
import { getStorage } from "./storage";
import { Resend } from "resend";
import { quoteFormSchema } from "@shared/schema";
import { getAvailableSlots, bookSlot } from "./calendar";
import Stripe from "stripe";

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

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Your Cleaning Quote</title></head>
<body style="margin:0;padding:0;background:#f7f6f2;font-family:'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:#01696f;padding:32px 40px;">
      <h1 style="color:#fff;margin:0;font-size:24px;font-weight:700;">Clean Wizz</h1>
      <p style="color:#a7d8db;margin:4px 0 0;font-size:14px;">Professional Cleaning Services</p>
    </div>
    <div style="padding:32px 40px;">
      <h2 style="color:#28251d;font-size:20px;margin:0 0 8px;">Hi ${client.name},</h2>
      <p style="color:#7a7974;font-size:15px;margin:0 0 24px;">Here is your cleaning quote. Please review the details below.</p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#f7f6f2;">
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#7a7974;font-weight:600;border-bottom:2px solid #e5e7eb;">Service</th>
            <th style="padding:10px 12px;text-align:right;font-size:13px;color:#7a7974;font-weight:600;border-bottom:2px solid #e5e7eb;">Amount</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
      </table>

      ${quote.discount > 0 ? `
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#7a7974;font-size:14px;">Subtotal</span>
        <span style="color:#28251d;font-size:14px;">$${quote.subtotal.toFixed(2)} CAD</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#437a22;font-size:14px;">Promo (${quote.promoCode})</span>
        <span style="color:#437a22;font-size:14px;">-$${quote.discount.toFixed(2)} CAD</span>
      </div>` : ""}

      <div style="background:#f7f6f2;border-radius:8px;padding:16px;display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
        <span style="font-size:18px;font-weight:700;color:#28251d;">Total</span>
        <span style="font-size:24px;font-weight:700;color:#01696f;">$${quote.total.toFixed(2)} CAD</span>
      </div>

      <p style="color:#7a7974;font-size:13px;margin-bottom:24px;">This quote is valid until <strong style="color:#28251d;">${expiryDate}</strong>.</p>

      <a href="${bookUrl}" style="display:inline-block;background:#01696f;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">Accept &amp; Choose a Time Slot →</a>
      <p style="color:#7a7974;font-size:12px;margin-top:12px;">You'll be able to pick a date and time that works for you.</p>
    </div>
    <div style="padding:20px 40px;background:#f7f6f2;border-top:1px solid #e5e7eb;">
      <p style="color:#bab9b4;font-size:12px;margin:0;">Clean Wizz · Professional Cleaning Services · Quote ID: ${quote.id.slice(0, 8)}</p>
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
            from:    process.env.FROM_EMAIL || "Clean Wizz <quotes@cleanwizz.ca>",
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
        from:    process.env.FROM_EMAIL || "Clean Wizz <quotes@cleanwizz.ca>",
        to:      client.email,
        subject: `Your Cleaning Quote from Clean Wizz — $${q.total.toFixed(2)} CAD`,
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
          from:    process.env.FROM_EMAIL || "Clean Wizz <quotes@cleanwizz.ca>",
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
          from:    process.env.FROM_EMAIL || "Clean Wizz <quotes@cleanwizz.ca>",
          to:      client.email,
          subject: `📅 Your Cleaning is Booked — ${slotLabel}`,
          html: `
            <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;">
              <div style="background:#01696f;padding:28px 36px;border-radius:12px 12px 0 0;">
                <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Clean Wizz</h1>
                <p style="color:#a7d8db;margin:4px 0 0;font-size:14px;">Professional Cleaning Services</p>
              </div>
              <div style="background:#fff;padding:32px 36px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
                <h2 style="color:#28251d;font-size:20px;margin:0 0 8px;">Hi ${client.name}, you're booked! 🎉</h2>
                <p style="color:#7a7974;font-size:15px;margin:0 0 24px;">Here's a summary of your upcoming cleaning appointment.</p>

                <div style="background:#f0fafa;border:1px solid #a7d8db;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
                  <p style="margin:0;font-size:16px;font-weight:700;color:#01696f;">📅 ${slotLabel}</p>
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
