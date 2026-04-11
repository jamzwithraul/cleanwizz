import type { Express } from "express";
import type { Server } from "http";
import { getStorage } from "./storage";
import { Resend } from "resend";
import { quoteFormSchema } from "@shared/schema";

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
  const acceptUrl = `${baseUrl}/api/quotes/${quote.id}/accept`;

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

      <a href="${acceptUrl}" style="display:inline-block;background:#01696f;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">Accept This Quote</a>
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
          const linesSummary = items.map(i => `${i.description}: $${i.amount.toFixed(2)}`).join("<br>");
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
                  <tr><td style="padding:6px 0;color:#555;">Service</td><td>${q.serviceType}</td></tr>
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
