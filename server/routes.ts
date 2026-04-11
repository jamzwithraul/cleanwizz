import type { Express } from "express";
import type { Server } from "http";
import { getStorage } from "./storage";
import { Resend } from "resend";
import { quoteFormSchema } from "@shared/schema";
import { getAvailableSlots, bookSlot } from "./calendar";

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
  const slotOptions = slots.map(s =>
    `<option value="${s.start}|${s.end}">${s.label}</option>`
  ).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Book Your Cleaning — Clean Wizz</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',sans-serif;background:#f7f6f2;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,.10);max-width:520px;width:100%}
    .header{background:#01696f;padding:28px 36px}
    .header h1{color:#fff;font-size:22px;font-weight:700;margin:0}
    .header p{color:#a7d8db;font-size:14px;margin:4px 0 0}
    .body{padding:32px 36px}
    .body h2{font-size:18px;color:#28251d;margin-bottom:6px}
    .body .sub{color:#7a7974;font-size:14px;margin-bottom:24px}
    .total-badge{background:#f0fafa;border:1px solid #a7d8db;border-radius:8px;padding:12px 16px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center}
    .total-badge span{color:#7a7974;font-size:14px}
    .total-badge strong{color:#01696f;font-size:20px;font-weight:700}
    label{display:block;font-size:13px;font-weight:600;color:#28251d;margin-bottom:6px}
    select{width:100%;padding:12px 14px;border:1px solid #e5e7eb;border-radius:8px;font-size:15px;color:#28251d;background:#fff;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%237a7974' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;cursor:pointer}
    select:focus{outline:none;border-color:#01696f;box-shadow:0 0 0 3px rgba(1,105,111,.1)}
    .btn{display:block;width:100%;margin-top:20px;background:#01696f;color:#fff;border:none;padding:14px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:background .15s}
    .btn:hover{background:#015a60}
    .btn:disabled{background:#bab9b4;cursor:not-allowed}
    .msg{margin-top:16px;padding:12px 16px;border-radius:8px;font-size:14px;text-align:center;display:none}
    .msg.success{background:#f0fafa;color:#01696f;border:1px solid #a7d8db}
    .msg.error{background:#fff0f0;color:#c0392b;border:1px solid #f5c6c6}
    .footer{padding:16px 36px;background:#f7f6f2;border-top:1px solid #e5e7eb}
    .footer p{color:#bab9b4;font-size:12px}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Clean Wizz</h1>
      <p>Professional Cleaning Services</p>
    </div>
    <div class="body">
      <h2>Hi ${clientName}!</h2>
      <p class="sub">Choose a date and time that works for you and we'll confirm your booking right away.</p>

      <div class="total-badge">
        <span>Your quote total</span>
        <strong>$${quote.total.toFixed(2)} CAD</strong>
      </div>

      ${slots.length === 0
        ? `<p style="color:#c0392b;text-align:center;padding:20px 0;">No available slots right now. Please call us to book directly.</p>`
        : `<label for="slot">Select a time slot</label>
           <select id="slot">
             <option value="">— Pick a date and time —</option>
             ${slotOptions}
           </select>
           <button class="btn" id="bookBtn" disabled>Confirm Booking</button>`
      }

      <div class="msg" id="msg"></div>
    </div>
    <div class="footer">
      <p>Clean Wizz · Quote ID: ${quote.id.slice(0, 8)}</p>
    </div>
  </div>

  <script>
    const select = document.getElementById('slot');
    const btn = document.getElementById('bookBtn');
    const msg = document.getElementById('msg');

    if (select) {
      select.addEventListener('change', () => {
        btn.disabled = !select.value;
      });
    }

    if (btn) {
      btn.addEventListener('click', async () => {
        const [start, end] = select.value.split('|');
        btn.disabled = true;
        btn.textContent = 'Booking...';
        msg.style.display = 'none';

        try {
          const res = await fetch('${baseUrl}/api/booking/book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteId: '${quote.id}', start, end }),
          });
          const data = await res.json();

          if (res.ok && data.success) {
            btn.style.display = 'none';
            select.style.display = 'none';
            document.querySelector('label').style.display = 'none';
            msg.className = 'msg success';
            msg.style.display = 'block';
            msg.innerHTML = '📅 <strong>Booking confirmed!</strong> You\'ll receive a calendar invite shortly. We look forward to seeing you!';
          } else {
            throw new Error(data.error || 'Booking failed');
          }
        } catch (err) {
          msg.className = 'msg error';
          msg.style.display = 'block';
          msg.textContent = 'Something went wrong. Please try again or call us directly.';
          btn.disabled = false;
          btn.textContent = 'Confirm Booking';
        }
      });
    }
  </script>
</body>
</html>`;
}
