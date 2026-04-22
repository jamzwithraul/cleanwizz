/**
 * Customer portal — Sprint E
 *
 * Endpoints for authenticated subscription customers.
 * All routes require `Authorization: Bearer <supabase-jwt>`.
 * The JWT is verified via the existing verifyJwt helper in requireAuth.
 * The caller's email is extracted from the JWT and used to look up their subscription.
 */

import type { Express, Request, Response } from "express";
import { extractBearer, verifyJwt } from "./middleware/requireAuth";
import { hsSupa } from "./subscriptions";

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Reads the Bearer token from the request, verifies it, and returns the caller's
 * email address.  Returns null (and sends a 401) when the token is missing/invalid.
 */
async function requireCustomerAuth(
  req: Request,
  res: Response,
): Promise<string | null> {
  const token = extractBearer(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const user = await verifyJwt(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return user.email;
}

// ── Subscription lookup helper ────────────────────────────────────────────────

/**
 * Fetches the caller's active or paused subscription by their email.
 * Returns null (and sends a 404) if no matching subscription is found.
 */
async function getSubscriptionForEmail(
  email: string,
  res: Response,
) {
  if (!hsSupa) {
    res.status(503).json({ error: "Database not available." });
    return null;
  }

  const { data: sub, error } = await hsSupa
    .from("subscriptions")
    .select("*")
    .eq("customer_email", email)
    .in("status", ["active", "paused"])
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !sub) {
    res.status(404).json({ error: "No active subscription found for this account." });
    return null;
  }

  return sub;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerCustomerPortalRoutes(app: Express): void {

  // ── GET /api/me/subscription ───────────────────────────────────────────────
  // Returns the caller's active/paused subscription plus their recent job history.
  app.get("/api/me/subscription", async (req: Request, res: Response) => {
    try {
      const email = await requireCustomerAuth(req, res);
      if (!email) return;

      const sub = await getSubscriptionForEmail(email, res);
      if (!sub) return;

      // Fetch recent jobs for this subscription (last 10)
      const { data: jobs } = await hsSupa!
        .from("jobs")
        .select("id, scheduled_at, status, amount_cents, service_type, address")
        .eq("subscription_id", sub.id)
        .order("scheduled_at", { ascending: false })
        .limit(10);

      res.json({
        subscription: sub,
        recent_jobs: jobs ?? [],
      });
    } catch (err: any) {
      console.error("[GET /api/me/subscription]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/me/subscription/skip-next ───────────────────────────────────
  // Shifts next_visit_at forward by 14 days (one bi-weekly cycle).
  app.post("/api/me/subscription/skip-next", async (req: Request, res: Response) => {
    try {
      const email = await requireCustomerAuth(req, res);
      if (!email) return;

      const sub = await getSubscriptionForEmail(email, res);
      if (!sub) return;

      if (!sub.next_visit_at) {
        return res.status(400).json({ error: "No next visit scheduled." });
      }

      const current = new Date(sub.next_visit_at);
      const shifted = new Date(current.getTime() + 14 * 24 * 60 * 60 * 1000);
      const newNextVisitAt = shifted.toISOString();

      const { error: updateErr } = await hsSupa!
        .from("subscriptions")
        .update({ next_visit_at: newNextVisitAt })
        .eq("id", sub.id);

      if (updateErr) throw new Error(updateErr.message);

      res.json({
        success: true,
        previous_next_visit_at: sub.next_visit_at,
        next_visit_at: newNextVisitAt,
      });
    } catch (err: any) {
      console.error("[POST /api/me/subscription/skip-next]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/me/subscription/pause ───────────────────────────────────────
  // Body: { paused_until: iso_date }
  // Sets status='paused' and records paused_until.
  app.post("/api/me/subscription/pause", async (req: Request, res: Response) => {
    try {
      const email = await requireCustomerAuth(req, res);
      if (!email) return;

      const sub = await getSubscriptionForEmail(email, res);
      if (!sub) return;

      const { paused_until } = req.body;
      if (!paused_until) {
        return res.status(400).json({ error: "paused_until (ISO date) is required." });
      }

      const pausedUntilDate = new Date(paused_until);
      if (isNaN(pausedUntilDate.getTime())) {
        return res.status(400).json({ error: "paused_until must be a valid ISO date." });
      }

      if (pausedUntilDate <= new Date()) {
        return res.status(400).json({ error: "paused_until must be a future date." });
      }

      const { error: updateErr } = await hsSupa!
        .from("subscriptions")
        .update({
          status: "paused",
          paused_until: pausedUntilDate.toISOString(),
        })
        .eq("id", sub.id);

      if (updateErr) throw new Error(updateErr.message);

      res.json({
        success: true,
        status: "paused",
        paused_until: pausedUntilDate.toISOString(),
      });
    } catch (err: any) {
      console.error("[POST /api/me/subscription/pause]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/me/subscription/resume ──────────────────────────────────────
  // Sets status='active' and clears paused_until.
  app.post("/api/me/subscription/resume", async (req: Request, res: Response) => {
    try {
      const email = await requireCustomerAuth(req, res);
      if (!email) return;

      // For resume, allow looking up paused subscriptions specifically
      if (!hsSupa) return res.status(503).json({ error: "Database not available." });

      const { data: sub, error: fetchErr } = await hsSupa
        .from("subscriptions")
        .select("*")
        .eq("customer_email", email)
        .eq("status", "paused")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (fetchErr || !sub) {
        return res.status(404).json({ error: "No paused subscription found for this account." });
      }

      const { error: updateErr } = await hsSupa
        .from("subscriptions")
        .update({
          status: "active",
          paused_until: null,
        })
        .eq("id", sub.id);

      if (updateErr) throw new Error(updateErr.message);

      res.json({
        success: true,
        status: "active",
        subscription_id: sub.id,
      });
    } catch (err: any) {
      console.error("[POST /api/me/subscription/resume]", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/me/subscription/cancel ──────────────────────────────────────
  // Sets status='cancelled', records cancelled_at, and removes founders_lock.
  app.post("/api/me/subscription/cancel", async (req: Request, res: Response) => {
    try {
      const email = await requireCustomerAuth(req, res);
      if (!email) return;

      const sub = await getSubscriptionForEmail(email, res);
      if (!sub) return;

      const { error: updateErr } = await hsSupa!
        .from("subscriptions")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          founders_lock: false,
        })
        .eq("id", sub.id);

      if (updateErr) throw new Error(updateErr.message);

      res.json({
        success: true,
        status: "cancelled",
        subscription_id: sub.id,
        message:
          "Your subscription has been cancelled. Your founders' rate lock has been released.",
      });
    } catch (err: any) {
      console.error("[POST /api/me/subscription/cancel]", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
