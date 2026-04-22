/**
 * guarantee-routes.ts — 200% Satisfaction Guarantee enforcement endpoints.
 *
 * Sprint I — Parts 1, 3, 4, 5, 6, 7.
 *
 * Registered by server/index.ts (or routes.ts) via:
 *   import { registerGuaranteeRoutes } from "./guarantee-routes";
 *   registerGuaranteeRoutes(app);
 *
 * All admin endpoints require requireAuth + caller must be in ADMIN_EMAILS.
 * All contractor endpoints require requireAuth + caller must own the contractor row.
 * Client reclean endpoint requires requireAuth (Supabase JWT).
 */

import type { Express, Request, Response } from "express";
import { createClient }                     from "@supabase/supabase-js";
import { Resend }                           from "resend";
import Stripe                               from "stripe";
import { requireAuth }                      from "./middleware/requireAuth";
import { sendContractorAgreement, RECLEAN_CLAUSE_VERSION } from "./signwell";
import { runSlaBreachSweep }                from "./cron/guarantee-sla";

// ── Clients ───────────────────────────────────────────────────────────────────
const HS_SUPABASE_URL = process.env.HS_SUPABASE_URL  || "https://gjfeqnfmwbsfwnbepwvu.supabase.co";
const HS_SERVICE_KEY  = process.env.HS_SUPABASE_SERVICE_ROLE_KEY || "";

function getHsSupa() {
  if (!HS_SERVICE_KEY) return null;
  return createClient(HS_SUPABASE_URL, HS_SERVICE_KEY);
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ── Admin emails (mirrors AdminDashboard.tsx constant) ────────────────────────
const ADMIN_EMAILS = ["jamzwithraul@gmail.com", "admin@harrietscleaning.ca", "magic@harrietscleaning.ca"];

function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

const FROM = process.env.FROM_EMAIL || "Harriet's Spotless Cleaning Co. <magic@harrietscleaning.ca>";
const OWNER_EMAIL = "magic@harrietscleaning.ca";

// ── Email helpers ─────────────────────────────────────────────────────────────

function sendMail(to: string, subject: string, html: string) {
  if (!resend) {
    console.log(`[guarantee] DEV email to ${to}: ${subject}`);
    return Promise.resolve();
  }
  return resend.emails.send({ from: FROM, to, subject, html }).catch((e: any) =>
    console.error("[guarantee] email error:", e?.message),
  );
}

function recleanAdminNotifyHtml(opts: {
  clientEmail: string;
  jobId: string;
  description: string;
  photoUrls: string[];
  requestId: string;
}) {
  const photoLinks = opts.photoUrls
    .map(u => `<a href="${u}" style="color:#a01733;">${u}</a>`)
    .join("<br>");
  return `
    <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px;">
      <h2 style="color:#a01733;">New Reclean Request</h2>
      <p><strong>Client:</strong> ${opts.clientEmail}</p>
      <p><strong>Job ID:</strong> ${opts.jobId}</p>
      <p><strong>Request ID:</strong> ${opts.requestId}</p>
      <p><strong>Description:</strong><br>${opts.description}</p>
      ${opts.photoUrls.length ? `<p><strong>Photos:</strong><br>${photoLinks}</p>` : ""}
      <p style="margin-top:24px;">
        <a href="https://harrietscleaning.ca/admin" style="background:#a01733;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">
          Review in Admin Dashboard
        </a>
      </p>
    </div>`;
}

function recleanClientConfirmHtml(clientEmail: string) {
  return `
    <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#fdf8f0;">
      <h2 style="color:#6b1629;">Your Reclean Request Has Been Received</h2>
      <p>Hi,</p>
      <p>We've received your reclean request and our team will review it within <strong>4 hours</strong>. Once approved, we'll dispatch a specialist within <strong>48 business hours</strong>.</p>
      <p>If you have any questions, reply to this email or contact us at <a href="mailto:support@harrietsspotless.ca">support@harrietsspotless.ca</a>.</p>
      <p style="color:#7a7974;font-size:13px;margin-top:32px;">Harriet's Spotless Cleaning Co. · harrietscleaning.ca</p>
    </div>`;
}

function recleanContractorDispatchHtml(opts: {
  contractorName: string;
  jobId: string;
  description: string;
  photoUrls: string[];
  requestId: string;
}) {
  const photoLinks = opts.photoUrls
    .map(u => `<a href="${u}" style="color:#a01733;">${u}</a>`)
    .join("<br>");
  return `
    <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px;">
      <h2 style="color:#a01733;">Reclean Assignment</h2>
      <p>Hi <strong>${opts.contractorName}</strong>,</p>
      <p>A client has submitted a reclean request for a job you recently completed. As per our 200% satisfaction guarantee and your contractor agreement (Section X), please return within <strong>48 business hours</strong> to address the following:</p>
      <div style="background:#fdf2f4;border:1px solid #f4a3b2;border-radius:8px;padding:16px;margin:16px 0;">
        <p><strong>Client feedback:</strong><br>${opts.description}</p>
        ${opts.photoUrls.length ? `<p><strong>Reference photos:</strong><br>${photoLinks}</p>` : ""}
      </div>
      <p>Once you have completed the reclean, please mark it complete in your contractor portal at <a href="https://harrietscleaning.ca/contractor">harrietscleaning.ca/contractor</a>.</p>
      <p>If you are unable to return within 48 business hours, notify us <strong>within 4 hours</strong> so we can arrange coverage.</p>
      <p style="color:#7a7974;font-size:13px;margin-top:32px;">Harriet's Spotless Cleaning Co. · harrietscleaning.ca</p>
    </div>`;
}

function refundClientHtml(opts: { clientEmail: string; amountDollars: string }) {
  return `
    <div style="font-family:'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#fdf8f0;">
      <h2 style="color:#6b1629;">Refund Issued</h2>
      <p>Hi,</p>
      <p>Your refund of <strong>$${opts.amountDollars} CAD</strong> has been issued and should appear on your original payment method within <strong>5–10 business days</strong>.</p>
      <p>If you have any questions, contact us at <a href="mailto:support@harrietsspotless.ca">support@harrietsspotless.ca</a>.</p>
      <p style="color:#7a7974;font-size:13px;margin-top:32px;">Harriet's Spotless Cleaning Co. · harrietscleaning.ca</p>
    </div>`;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerGuaranteeRoutes(app: Express) {
  const supa = getHsSupa;   // factory — called per-request to avoid stale clients

  // ══════════════════════════════════════════════════════════════════════════
  // PART 1 — SignWell: resend agreement to contractor
  // POST /api/admin/contractors/:id/resend-signwell
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/admin/contractors/:id/resend-signwell", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!isAdmin(req.user!.email)) {
        return res.status(403).json({ error: "Admin only." });
      }
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id, full_name, email, signwell_reclean_clause_version")
        .eq("id", req.params.id)
        .single();

      if (cErr || !contractor) return res.status(404).json({ error: "Contractor not found." });

      const { documentId, signingUrl } = await sendContractorAgreement({
        contractorId:    contractor.id,
        contractorName:  contractor.full_name,
        contractorEmail: contractor.email,
        isResend:        true,
      });

      // Record pending resend in DB — version stays at old value until signed
      await hsSupa
        .from("contractor_applications")
        .update({ signwell_resend_document_id: documentId, updated_at: new Date().toISOString() })
        .eq("id", contractor.id);

      console.log(`[signwell] Resent agreement to ${contractor.email}, document=${documentId}`);

      return res.json({
        success: true,
        documentId,
        signingUrl,
        message: `Re-signature request sent to ${contractor.email}.`,
      });
    } catch (err: any) {
      console.error("[signwell] Resend error:", err?.message);
      return res.status(500).json({ error: err.message || "Failed to send re-signature request." });
    }
  });

  // GET /api/admin/contractors/signwell-status — list version + re-sign needed
  app.get("/api/admin/contractors/signwell-status", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!isAdmin(req.user!.email)) return res.status(403).json({ error: "Admin only." });
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const { data, error } = await hsSupa
        .from("contractor_applications")
        .select("id, full_name, email, status, signwell_reclean_clause_version")
        .in("status", ["approved", "onboarded"])
        .order("full_name");

      if (error) return res.status(500).json({ error: error.message });

      const rows = (data ?? []).map((c: any) => ({
        id:             c.id,
        full_name:      c.full_name,
        email:          c.email,
        status:         c.status,
        clause_version: c.signwell_reclean_clause_version ?? 0,
        needs_resign:   (c.signwell_reclean_clause_version ?? 0) < RECLEAN_CLAUSE_VERSION,
      }));

      return res.json({ rows, current_version: RECLEAN_CLAUSE_VERSION });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PART 3 — Client: submit reclean request
  // POST /api/me/reclean-request
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/me/reclean-request", requireAuth, async (req: Request, res: Response) => {
    try {
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const { job_id, description, photo_urls } = req.body as {
        job_id:      string;
        description: string;
        photo_urls?: string[];
      };

      if (!job_id || typeof job_id !== "string") {
        return res.status(400).json({ error: "job_id is required." });
      }
      if (!description || typeof description !== "string" || description.trim().length < 30) {
        return res.status(400).json({ error: "description must be at least 30 characters." });
      }

      // Fetch the job and verify ownership via client_email
      const { data: job, error: jobErr } = await hsSupa
        .from("jobs")
        .select("id, client_email, client_name, completed_at, status")
        .eq("id", job_id)
        .single();

      if (jobErr || !job) return res.status(404).json({ error: "Job not found." });

      // Server-side ownership check — email from JWT must match job client_email
      const callerEmail = req.user!.email.toLowerCase();
      const jobEmail    = (job.client_email || "").toLowerCase();

      if (jobEmail !== callerEmail) {
        return res.status(403).json({ error: "This job does not belong to your account." });
      }

      // Server-side 24-hour window enforcement
      if (!job.completed_at) {
        return res.status(400).json({
          error: "This job has not been marked complete yet. Reclean requests are only accepted after completion.",
        });
      }

      const completedAt   = new Date(job.completed_at).getTime();
      const msElapsed     = Date.now() - completedAt;
      const WINDOW_MS     = 24 * 60 * 60 * 1000; // 24 hours

      if (msElapsed > WINDOW_MS) {
        return res.status(400).json({
          error: "Reclean requests must be submitted within 24 hours of service completion. Please contact support@harrietsspotless.ca.",
        });
      }

      // Ensure no previous reclean request for this job
      const { data: existing } = await hsSupa
        .from("reclean_requests")
        .select("id, status")
        .eq("job_id", job_id)
        .not("status", "eq", "denied")
        .limit(1);

      if (existing && existing.length > 0) {
        return res.status(409).json({
          error: "A reclean request already exists for this job.",
          existing_id: existing[0].id,
        });
      }

      // Insert the reclean request
      const { data: newRequest, error: insertErr } = await hsSupa
        .from("reclean_requests")
        .insert({
          job_id,
          client_email:  callerEmail,
          description:   description.trim(),
          photos_urls:   photo_urls ?? [],
          status:        "pending",
          requested_at:  new Date().toISOString(),
        })
        .select()
        .single();

      if (insertErr || !newRequest) {
        console.error("[reclean] Insert error:", insertErr?.message);
        return res.status(500).json({ error: "Failed to submit reclean request." });
      }

      // Emails: admin notify + client confirmation
      await Promise.allSettled([
        sendMail(
          OWNER_EMAIL,
          `Reclean Request — Job ${job_id.slice(0, 8)} (${callerEmail})`,
          recleanAdminNotifyHtml({
            clientEmail: callerEmail,
            jobId:       job_id,
            description: description.trim(),
            photoUrls:   photo_urls ?? [],
            requestId:   newRequest.id,
          }),
        ),
        sendMail(
          callerEmail,
          "Your Reclean Request Has Been Received — Harriet's Spotless",
          recleanClientConfirmHtml(callerEmail),
        ),
      ]);

      return res.status(201).json({
        success: true,
        id:      newRequest.id,
        message: "Your reclean request has been submitted. We'll review within 4 hours and confirm dispatch.",
      });
    } catch (err: any) {
      console.error("[reclean] Submit error:", err?.message || err);
      return res.status(500).json({ error: err.message || "Internal server error." });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PART 4 — Admin: reclean request management
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/admin/reclean-requests?status=pending
  app.get("/api/admin/reclean-requests", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!isAdmin(req.user!.email)) return res.status(403).json({ error: "Admin only." });
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const statusFilter = req.query.status as string | undefined;

      let query = hsSupa
        .from("reclean_requests")
        .select(`
          *,
          jobs!reclean_requests_job_id_fkey (
            id,
            client_name,
            client_address,
            service_type,
            scheduled_start,
            contractor_id
          ),
          contractor_applications!reclean_requests_dispatched_to_contractor_id_fkey (
            id,
            full_name,
            email
          )
        `)
        .order("requested_at", { ascending: false });

      if (statusFilter) {
        query = query.eq("status", statusFilter) as any;
      }

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });

      return res.json(data ?? []);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/reclean-requests/:id/approve
  app.post("/api/admin/reclean-requests/:id/approve", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!isAdmin(req.user!.email)) return res.status(403).json({ error: "Admin only." });
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const { contractor_id } = req.body as { contractor_id: string };
      if (!contractor_id) return res.status(400).json({ error: "contractor_id is required." });

      // Check contractor clause version gate before dispatch
      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id, full_name, email, signwell_reclean_clause_version")
        .eq("id", contractor_id)
        .single();

      if (cErr || !contractor) return res.status(404).json({ error: "Contractor not found." });

      if ((contractor.signwell_reclean_clause_version ?? 0) < RECLEAN_CLAUSE_VERSION) {
        return res.status(403).json({
          error: `Contractor has not signed the updated agreement (version ${RECLEAN_CLAUSE_VERSION}). Request re-signature before dispatching.`,
          contractor_id,
          current_version: contractor.signwell_reclean_clause_version ?? 0,
          required_version: RECLEAN_CLAUSE_VERSION,
        });
      }

      // Load the reclean request
      const { data: request, error: rErr } = await hsSupa
        .from("reclean_requests")
        .select("*")
        .eq("id", req.params.id)
        .single();

      if (rErr || !request) return res.status(404).json({ error: "Reclean request not found." });
      if (request.status !== "pending") {
        return res.status(409).json({ error: `Cannot approve a request in status '${request.status}'.` });
      }

      const now = new Date().toISOString();
      const { data: updated, error: updErr } = await hsSupa
        .from("reclean_requests")
        .update({
          status:                      "dispatched",
          dispatched_to_contractor_id: contractor_id,
          dispatched_at:               now,
        })
        .eq("id", req.params.id)
        .select()
        .single();

      if (updErr) return res.status(500).json({ error: updErr.message });

      // Email contractor
      await sendMail(
        contractor.email,
        "Reclean Assignment — Harriet's Spotless",
        recleanContractorDispatchHtml({
          contractorName: contractor.full_name,
          jobId:          request.job_id,
          description:    request.description,
          photoUrls:      request.photos_urls ?? [],
          requestId:      request.id,
        }),
      );

      return res.json({ success: true, request: updated });
    } catch (err: any) {
      console.error("[admin/reclean/approve] Error:", err?.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/reclean-requests/:id/deny
  app.post("/api/admin/reclean-requests/:id/deny", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!isAdmin(req.user!.email)) return res.status(403).json({ error: "Admin only." });
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const { reason } = req.body as { reason: string };
      if (!reason || !reason.trim()) {
        return res.status(400).json({ error: "reason is required." });
      }

      const { data: request, error: rErr } = await hsSupa
        .from("reclean_requests")
        .select("id, status, client_email")
        .eq("id", req.params.id)
        .single();

      if (rErr || !request) return res.status(404).json({ error: "Reclean request not found." });
      if (request.status !== "pending") {
        return res.status(409).json({ error: `Cannot deny a request in status '${request.status}'.` });
      }

      const now = new Date().toISOString();
      const { data: updated, error: updErr } = await hsSupa
        .from("reclean_requests")
        .update({
          status:        "denied",
          denied_reason: reason.trim(),
          denied_at:     now,
        })
        .eq("id", req.params.id)
        .select()
        .single();

      if (updErr) return res.status(500).json({ error: updErr.message });

      return res.json({ success: true, request: updated });
    } catch (err: any) {
      console.error("[admin/reclean/deny] Error:", err?.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/reclean-requests/:id/mark-completed
  app.post("/api/admin/reclean-requests/:id/mark-completed", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!isAdmin(req.user!.email)) return res.status(403).json({ error: "Admin only." });
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const { data: request, error: rErr } = await hsSupa
        .from("reclean_requests")
        .select("id, status")
        .eq("id", req.params.id)
        .single();

      if (rErr || !request) return res.status(404).json({ error: "Reclean request not found." });

      const { data: updated, error: updErr } = await hsSupa
        .from("reclean_requests")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", req.params.id)
        .select()
        .single();

      if (updErr) return res.status(500).json({ error: updErr.message });

      return res.json({ success: true, request: updated });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PART 5 — Contractor: reclean assignments
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/contractor/reclean-assignments
  app.get("/api/contractor/reclean-assignments", requireAuth, async (req: Request, res: Response) => {
    try {
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const callerEmail = req.user!.email.toLowerCase();

      // Resolve contractor row from JWT email
      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id")
        .ilike("email", callerEmail)
        .maybeSingle();

      if (cErr || !contractor) return res.status(403).json({ error: "No contractor record for this account." });

      // Fetch dispatched reclean requests for this contractor
      // NEVER include client price data — select only safe fields from joined job
      const { data, error } = await hsSupa
        .from("reclean_requests")
        .select(`
          id,
          job_id,
          client_email,
          description,
          photos_urls,
          status,
          dispatched_at,
          sla_breached,
          requested_at,
          jobs!reclean_requests_job_id_fkey (
            id,
            client_address,
            service_type,
            scheduled_start,
            scheduled_end,
            client_name
          )
        `)
        .eq("dispatched_to_contractor_id", contractor.id)
        .eq("status", "dispatched")
        .order("dispatched_at", { ascending: false });

      if (error) return res.status(500).json({ error: error.message });

      // Strip any price-related fields before returning — belt-and-suspenders
      const safe = (data ?? []).map((r: any) => {
        const job = r.jobs ?? {};
        return {
          id:           r.id,
          job_id:       r.job_id,
          description:  r.description,
          photos_urls:  r.photos_urls,
          status:       r.status,
          dispatched_at: r.dispatched_at,
          sla_breached: r.sla_breached,
          requested_at: r.requested_at,
          job: {
            id:              job.id,
            client_address:  job.client_address,
            service_type:    job.service_type,
            scheduled_start: job.scheduled_start,
            scheduled_end:   job.scheduled_end,
            client_name:     job.client_name,
            // pay_amount intentionally excluded
          },
        };
      });

      return res.json(safe);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/contractor/reclean/:id/complete — contractor marks reclean done
  app.post("/api/contractor/reclean/:id/complete", requireAuth, async (req: Request, res: Response) => {
    try {
      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const callerEmail = req.user!.email.toLowerCase();

      const { data: contractor, error: cErr } = await hsSupa
        .from("contractor_applications")
        .select("id")
        .ilike("email", callerEmail)
        .maybeSingle();

      if (cErr || !contractor) return res.status(403).json({ error: "No contractor record for this account." });

      // Verify this reclean belongs to this contractor
      const { data: request, error: rErr } = await hsSupa
        .from("reclean_requests")
        .select("id, status, dispatched_to_contractor_id")
        .eq("id", req.params.id)
        .single();

      if (rErr || !request) return res.status(404).json({ error: "Reclean request not found." });
      if (request.dispatched_to_contractor_id !== contractor.id) {
        return res.status(403).json({ error: "This reclean is not assigned to your account." });
      }
      if (request.status !== "dispatched") {
        return res.status(409).json({ error: `Cannot complete a request in status '${request.status}'.` });
      }

      const { data: updated, error: updErr } = await hsSupa
        .from("reclean_requests")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", req.params.id)
        .select()
        .single();

      if (updErr) return res.status(500).json({ error: updErr.message });

      // Notify admin
      await sendMail(
        OWNER_EMAIL,
        `Reclean Completed — Request ${req.params.id.slice(0, 8)}`,
        `<p>Contractor (${callerEmail}) has marked reclean request <strong>${req.params.id}</strong> as completed.</p>`,
      );

      return res.json({ success: true, request: updated });
    } catch (err: any) {
      console.error("[contractor/reclean/complete] Error:", err?.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PART 6 — Admin: refund
  // POST /api/admin/jobs/:id/refund
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/admin/jobs/:id/refund", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!isAdmin(req.user!.email)) return res.status(403).json({ error: "Admin only." });
      if (!stripe) return res.status(503).json({ error: "Stripe not configured." });

      const hsSupa = supa();
      if (!hsSupa) return res.status(503).json({ error: "Database unavailable." });

      const { amount_cents, reason } = req.body as { amount_cents: number; reason: string };

      if (typeof amount_cents !== "number" || amount_cents <= 0) {
        return res.status(400).json({ error: "amount_cents must be a positive integer." });
      }
      if (!reason || !reason.trim()) {
        return res.status(400).json({ error: "reason is required." });
      }

      // Fetch job — we need the quote_id to find the PaymentIntent
      const { data: job, error: jobErr } = await hsSupa
        .from("jobs")
        .select("id, quote_id, client_email, client_name")
        .eq("id", req.params.id)
        .single();

      if (jobErr || !job) return res.status(404).json({ error: "Job not found." });

      // Resolve PaymentIntent from the quote stored in cleanwizz Supabase
      // We call the cleanwizz storage directly here (same Supabase project pattern).
      // The PaymentIntent ID is stored on the quote row as payment_intent_id.
      let paymentIntentId: string | null = null;

      if (job.quote_id) {
        const { getStorage } = await import("./storage");
        const db = getStorage();
        const q  = await db.getQuote(job.quote_id);
        paymentIntentId = (q as any)?.paymentIntentId ?? null;
      }

      if (!paymentIntentId) {
        return res.status(400).json({
          error: "No Stripe PaymentIntent found for this job. Refund manually via the Stripe dashboard.",
          job_id: req.params.id,
        });
      }

      // Issue the refund via Stripe
      const stripeRefund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        amount:         amount_cents,
        reason:         "requested_by_customer",
        metadata: {
          job_id:    req.params.id,
          issued_by: req.user!.email,
          reason:    reason.trim().slice(0, 200),
        },
      });

      // Record in refunds table
      const { data: refundRow, error: rInsertErr } = await hsSupa
        .from("refunds")
        .insert({
          job_id:            req.params.id,
          amount_cents,
          stripe_refund_id:  stripeRefund.id,
          reason:            reason.trim(),
          issued_by_user_id: req.user!.id,
          issued_at:         new Date().toISOString(),
        })
        .select()
        .single();

      if (rInsertErr) {
        console.error("[admin/refund] Failed to insert refund row:", rInsertErr.message);
        // Don't fail — Stripe refund already issued
      }

      // Email client
      const amountDollars = (amount_cents / 100).toFixed(2);
      if (job.client_email) {
        await sendMail(
          job.client_email,
          "Your Refund Has Been Issued — Harriet's Spotless",
          refundClientHtml({ clientEmail: job.client_email, amountDollars }),
        );
      }

      console.log(`[admin/refund] Issued $${amountDollars} refund for job ${req.params.id} — stripe_refund_id=${stripeRefund.id}`);

      return res.json({
        success:          true,
        stripe_refund_id: stripeRefund.id,
        amount_cents,
        amount_dollars:   amountDollars,
        refund:           refundRow ?? null,
      });
    } catch (err: any) {
      console.error("[admin/refund] Error:", err?.message || err);
      return res.status(500).json({ error: err.message || "Refund failed." });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PART 7 — Cron: SLA breach sweep
  // POST /api/cron/sla-sweep   (protected by X-Cron-Secret header)
  // ══════════════════════════════════════════════════════════════════════════
  app.post("/api/cron/sla-sweep", async (req: Request, res: Response) => {
    const cronSecret = process.env.CRON_SECRET || "";
    const provided   = (req.headers["x-cron-secret"] as string | undefined) || "";

    if (!cronSecret || provided !== cronSecret) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    try {
      const result = await runSlaBreachSweep();
      return res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("[cron/sla-sweep] Error:", err?.message);
      return res.status(500).json({ error: err.message });
    }
  });
}
