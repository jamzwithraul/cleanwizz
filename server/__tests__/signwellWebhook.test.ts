/**
 * Integration test for /api/webhooks/signwell.
 *
 * Mocks @supabase/supabase-js (so contractor_applications lookups and storage
 * uploads are controllable), resend (so the email is a spy), and the SignWell
 * PDF-download helpers (so no real HTTP fires). Spins up Express via
 * registerRoutes and drives the handler with a signed request body.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import crypto from "crypto";

// ── Env must be set before importing routes.ts (module-level singletons) ────
process.env.RESEND_API_KEY = "re_test";
process.env.SIGNWELL_API_KEY = "sk_test";
process.env.SIGNWELL_TEMPLATE_ID = "tpl_test";
process.env.SIGNWELL_WEBHOOK_SECRET = "whsec_unit_test";
process.env.HS_SUPABASE_URL = "https://example.supabase.co";
process.env.HS_SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
process.env.HS_SUPABASE_ANON_KEY = "anon-key";

// ── Mutable mock state ──────────────────────────────────────────────────────
type ContractorRow = {
  id: string;
  full_name: string;
  email: string;
  agreement_status: string;
  agreement_signwell_document_id: string | null;
};

const state: {
  contractor: ContractorRow | null;
  uploads: Array<{ path: string; size: number }>;
  updates: Array<Record<string, unknown>>;
  sentEmails: Array<Record<string, unknown>>;
} = {
  contractor: null,
  uploads: [],
  updates: [],
  sentEmails: [],
};

function resetState(c: ContractorRow | null) {
  state.contractor = c;
  state.uploads = [];
  state.updates = [];
  state.sentEmails = [];
}

// ── Mocks ───────────────────────────────────────────────────────────────────
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (opts: Record<string, unknown>) => {
        state.sentEmails.push(opts);
        return { id: "re_mock" };
      },
    };
  },
}));

vi.mock("stripe", () => ({
  default: class {
    // Only constructed; no calls made in these tests.
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
    from: (_table: string) => makeQueryBuilder(),
    storage: {
      from: (_bucket: string) => ({
        upload: async (path: string, body: Buffer) => {
          state.uploads.push({ path, size: body.length });
          return { data: { path }, error: null };
        },
      }),
    },
  }),
}));

function makeQueryBuilder() {
  const b: any = {
    _filters: [] as Array<[string, string]>,
    select(_cols: string) {
      return b;
    },
    eq(col: string, val: string) {
      b._filters.push([col, val]);
      return b;
    },
    neq(_col: string, _val: string) {
      return b;
    },
    ilike(col: string, val: string) {
      b._filters.push([col, val]);
      return b;
    },
    order() {
      return b;
    },
    single: async () => resolveQuery(b),
    maybeSingle: async () => resolveQuery(b),
    update(patch: Record<string, unknown>) {
      state.updates.push(patch);
      const chain: any = {
        eq: () => chain,
        neq: () => chain,
        then: (resolve: any) => resolve({ data: null, error: null }),
      };
      return chain;
    },
    insert: async () => ({ data: null, error: null }),
  };
  return b;
}

function resolveQuery(b: any) {
  if (!state.contractor) return { data: null, error: null };
  // Match by doc id, id, or email filter
  const filters = b._filters as Array<[string, string]>;
  const docFilter = filters.find(([c]) => c === "agreement_signwell_document_id");
  if (docFilter && state.contractor.agreement_signwell_document_id === docFilter[1]) {
    return { data: state.contractor, error: null };
  }
  const idFilter = filters.find(([c]) => c === "id");
  if (idFilter && state.contractor.id === idFilter[1]) {
    return { data: state.contractor, error: null };
  }
  const emailFilter = filters.find(([c]) => c === "email");
  if (emailFilter) return { data: state.contractor, error: null };
  return { data: null, error: null };
}

// Mock the SignWell PDF downloads so the webhook can't reach the real API.
vi.mock("../signwell", async () => {
  const actual = await vi.importActual<typeof import("../signwell")>("../signwell");
  return {
    ...actual,
    downloadSignedPdf: vi.fn(async () => Buffer.from("SIGNED-PDF-BYTES")),
    downloadCertificate: vi.fn(async () => Buffer.from("CERT-PDF-BYTES")),
  };
});

// ── Imports after mocks are registered ──────────────────────────────────────
let app: any;
let registerRoutes: any;

beforeAll(async () => {
  const mod = await import("../routes");
  registerRoutes = mod.registerRoutes;
  const express = (await import("express")).default;
  app = express();
  app.use(
    express.json({
      verify: (req: any, _res: any, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );
  await registerRoutes({} as any, app);
});

beforeEach(() => {
  resetState({
    id: "contractor-uuid-1",
    full_name: "Jane Doe",
    email: "jane@example.com",
    agreement_status: "in_progress",
    agreement_signwell_document_id: "sw_doc_abc",
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function signBody(body: string, secret = "whsec_unit_test") {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

async function postWebhook(
  body: unknown,
  opts: { signature?: string; omitSig?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const sig = opts.signature ?? signBody(raw);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!opts.omitSig) headers["x-signwell-signature"] = sig;
  // Drive Express by calling its handler via a mock req/res.
  return await new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: "/api/webhooks/signwell",
      originalUrl: "/api/webhooks/signwell",
      headers,
      body: JSON.parse(raw),
      rawBody: Buffer.from(raw, "utf8"),
      socket: { remoteAddress: "127.0.0.1" },
      on: () => {},
      get(h: string) {
        return headers[h.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      _body: undefined as any,
      setHeader() {},
      getHeader() {},
      removeHeader() {},
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      send(payload: any) {
        res._body = payload;
        res.headersSent = true;
        resolve({ status: res.statusCode, body: payload });
        return res;
      },
      json(payload: any) {
        res._body = payload;
        res.headersSent = true;
        resolve({ status: res.statusCode, body: payload });
        return res;
      },
      end(payload?: any) {
        res._body = payload;
        res.headersSent = true;
        resolve({ status: res.statusCode, body: payload });
        return res;
      },
      on: () => {},
    };
    app.handle(req, res);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe("POST /api/webhooks/signwell", () => {
  const event = {
    event_type: "document_completed",
    data: {
      object: { id: "sw_doc_abc" },
    },
  };

  it("rejects a missing signature header with 401", async () => {
    const r = await postWebhook(event, { omitSig: true });
    expect(r.status).toBe(401);
    expect(state.updates).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
  });

  it("rejects an invalid signature with 401", async () => {
    const r = await postWebhook(event, { signature: signBody(JSON.stringify(event), "wrong") });
    expect(r.status).toBe(401);
    expect(state.updates).toHaveLength(0);
  });

  it("processes document_completed: uploads PDFs, flips status to signed, emails contractor", async () => {
    const r = await postWebhook(event);
    expect(r.status).toBe(200);
    expect(state.uploads).toHaveLength(2);
    expect(state.uploads[0].path).toMatch(/^contractor-uuid-1\/agreement\//);
    expect(state.uploads[1].path).toMatch(/^contractor-uuid-1\/agreement\//);
    // State transition writes
    expect(state.updates.length).toBeGreaterThanOrEqual(1);
    const patch = state.updates[state.updates.length - 1];
    expect(patch.agreement_status).toBe("signed");
    expect(patch.agreement_signed_at).toBeTruthy();
    expect(patch.agreement_document_url).toMatch(/agreement\//);
    expect(patch.agreement_certificate_url).toMatch(/agreement\//);

    // Allow the fire-and-forget email microtask to run
    await new Promise((r2) => setTimeout(r2, 10));
    expect(state.sentEmails).toHaveLength(1);
    expect((state.sentEmails[0] as any).to).toBe("jane@example.com");
  });

  it("is idempotent: a second delivery for an already-signed doc is a no-op", async () => {
    // First delivery
    await postWebhook(event);
    await new Promise((r2) => setTimeout(r2, 10));
    const uploadsAfterFirst = state.uploads.length;
    const updatesAfterFirst = state.updates.length;
    const emailsAfterFirst = state.sentEmails.length;

    // Flip the fixture to "signed" the way the real DB would have been updated.
    state.contractor!.agreement_status = "signed";

    const r = await postWebhook(event);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, duplicate: true });
    expect(state.uploads.length).toBe(uploadsAfterFirst); // no new uploads
    expect(state.updates.length).toBe(updatesAfterFirst); // no new db writes
    await new Promise((r2) => setTimeout(r2, 10));
    expect(state.sentEmails.length).toBe(emailsAfterFirst); // no duplicate email
  });

  it("ignores unrelated event types without changing state", async () => {
    const r = await postWebhook({
      event_type: "document_viewed",
      data: { object: { id: "sw_doc_abc" } },
    });
    expect(r.status).toBe(200);
    expect(state.updates).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
    expect(state.sentEmails).toHaveLength(0);
  });

  it("acks with a warning when the document id is unknown (no retry storm)", async () => {
    const r = await postWebhook({
      event_type: "document_completed",
      data: { object: { id: "sw_doc_not_here" } },
    });
    expect(r.status).toBe(200);
    expect(state.updates).toHaveLength(0);
    expect(state.uploads).toHaveLength(0);
  });
});
