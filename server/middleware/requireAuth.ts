/**
 * requireAuth — Express middleware
 *
 * Verifies `Authorization: Bearer <jwt>` against the Harry Spotter Supabase
 * project (which is the identity provider for all authenticated callers:
 * contractors, owner, admins). On success, attaches `req.user = { id, email }`.
 */

import type { Request, Response, NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

declare module "express-serve-static-core" {
  interface Request {
    user?: { id: string; email: string };
    internal?: boolean;
  }
}

function resolveEnv() {
  return {
    url: process.env.HS_SUPABASE_URL || process.env.SUPABASE_URL || "",
    anon: process.env.HS_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  };
}

let _client: SupabaseClient | null = null;
let _clientKey = "";
function getAuthClient(): SupabaseClient | null {
  const { url, anon } = resolveEnv();
  if (!url || !anon) return null;
  const key = `${url}::${anon}`;
  if (!_client || _clientKey !== key) {
    _client = createClient(url, anon);
    _clientKey = key;
  }
  return _client;
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  const token = parts[1];
  if (!token) return null;
  return token;
}

export async function verifyJwt(
  token: string,
): Promise<{ id: string; email: string } | null> {
  const sb = getAuthClient();
  if (!sb) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  const u = data.user;
  if (!u.email) return null;
  return { id: u.id, email: u.email };
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractBearer(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = await verifyJwt(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.user = user;
  next();
}

/**
 * requireAuthOrInternal — allow either a valid Supabase JWT OR a matching
 * X-Internal-Secret header (used for server-to-server calls from Supabase
 * Edge Functions into the Express API).
 */
export async function requireAuthOrInternal(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const internalSecret = process.env.INTERNAL_SERVICE_SECRET || "";
  const provided = (req.headers["x-internal-secret"] as string | undefined) || "";
  if (internalSecret && provided && provided === internalSecret) {
    req.internal = true;
    next();
    return;
  }
  return requireAuth(req, res, next);
}

// ── Simple in-memory IP rate limiter (v1 — TODO: swap for Redis) ────────────
const _ipBuckets = new Map<string, { count: number; resetAt: number }>();

export function ipRateLimit(opts: { max: number; windowMs: number }) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const bucket = _ipBuckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      _ipBuckets.set(ip, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    next();
  };
}

// Test-only reset hook — allows unit tests to clear the bucket between cases.
export function _resetRateLimiter(): void {
  _ipBuckets.clear();
}
