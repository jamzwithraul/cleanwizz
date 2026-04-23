import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  extractBearer,
  requireAuth,
  requireAuthOrInternal,
  ipRateLimit,
  _resetRateLimiter,
} from "../middleware/requireAuth";

// Mock @supabase/supabase-js so we can control auth.getUser() responses.
const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
  }),
}));

function mkReq(headers: Record<string, string | undefined> = {}) {
  return {
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as any;
}

function mkRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

beforeEach(() => {
  mockGetUser.mockReset();
  _resetRateLimiter();
  process.env.HS_SUPABASE_URL = "https://example.supabase.co";
  process.env.HS_SUPABASE_ANON_KEY = "anon-key";
});

describe("extractBearer", () => {
  it("pulls the token out of a well-formed header", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearer("bearer xyz")).toBe("xyz");
  });

  it("returns null for missing, malformed, or empty headers", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer("abc.def.ghi")).toBeNull();
    expect(extractBearer("Bearer")).toBeNull();
    expect(extractBearer("Basic abc")).toBeNull();
  });
});

describe("requireAuth", () => {
  it("rejects requests with no Authorization header", async () => {
    const req = mkReq();
    const res = mkRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("rejects malformed Authorization headers without contacting Supabase", async () => {
    const req = mkReq({ authorization: "Basic something" });
    const res = mkRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("rejects expired or invalid JWTs returned by Supabase", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "JWT expired" },
    });
    const req = mkReq({ authorization: "Bearer expired.jwt.token" });
    const res = mkRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches req.user and calls next() for a valid JWT", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: "user-123",
          email: "test@example.com",
        },
      },
      error: null,
    });
    const req = mkReq({ authorization: "Bearer valid.jwt.token" });
    const res = mkRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: "user-123", email: "test@example.com" });
  });
});

describe("requireAuthOrInternal", () => {
  it("accepts a matching X-Internal-Secret without a JWT", async () => {
    process.env.INTERNAL_SERVICE_SECRET = "shh";
    const req = mkReq({ "x-internal-secret": "shh" });
    const res = mkRes();
    const next = vi.fn();
    await requireAuthOrInternal(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.internal).toBe(true);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("falls through to JWT auth when internal secret is missing", async () => {
    process.env.INTERNAL_SERVICE_SECRET = "shh";
    const req = mkReq({ authorization: "Bearer nope", "x-internal-secret": "wrong" });
    const res = mkRes();
    const next = vi.fn();
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "bad" },
    });
    await requireAuthOrInternal(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("ipRateLimit", () => {
  it("allows traffic under the threshold and blocks above it", () => {
    const mw = ipRateLimit({ max: 2, windowMs: 60_000 });
    const nextA = vi.fn();
    const nextB = vi.fn();
    const nextC = vi.fn();
    const resA = mkRes();
    const resB = mkRes();
    const resC = mkRes();
    mw(mkReq(), resA, nextA);
    mw(mkReq(), resB, nextB);
    mw(mkReq(), resC, nextC);
    expect(nextA).toHaveBeenCalled();
    expect(nextB).toHaveBeenCalled();
    expect(nextC).not.toHaveBeenCalled();
    expect(resC.statusCode).toBe(429);
  });
});
