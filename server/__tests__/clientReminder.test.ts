import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

import {
  sendClientReminder,
  sendClientReminderUpdate,
  type SendClientReminderDeps,
} from "../clientReminders";
import {
  sendManualAssignmentNeededNotification,
  renderManualAssignmentNeededNotification,
} from "../emails/adminNotifications";
import { renderClientReminder } from "../emails/clientReminder";
import { renderClientReminderUpdate } from "../emails/clientReminderUpdate";

// ── Supabase fake ─────────────────────────────────────────────────────────────
// Mimics the chainable query builder the routes use: from(...).select(...).eq(...).single(),
// .update(...).eq(...), .insert(...).
function mkSupabase(state: {
  job?: any;
  customer?: any;
  contractor?: any;
  jobsUpdateErr?: string;
  ledger?: Set<string>;
  insertError?: { message: string; code?: string } | null;
}) {
  const ledger = state.ledger ?? new Set<string>();
  const calls = {
    jobsUpdate: 0,
    insert: 0,
    lastJobsUpdatePayload: undefined as any,
    inserts: [] as any[],
  };

  const from = (table: string): any => {
    if (table === "jobs") {
      return {
        select: (_cols: string) => ({
          eq: (_col: string, _id: string) => ({
            single: async () => (state.job ? { data: state.job, error: null } : { data: null, error: { message: "not found" } }),
          }),
        }),
        update: (payload: any) => {
          calls.jobsUpdate += 1;
          calls.lastJobsUpdatePayload = payload;
          return {
            eq: async () =>
              state.jobsUpdateErr
                ? { data: null, error: { message: state.jobsUpdateErr } }
                : { data: null, error: null },
          };
        },
      };
    }
    if (table === "customers") {
      return {
        select: () => ({
          eq: () => ({
            single: async () =>
              state.customer ? { data: state.customer, error: null } : { data: null, error: { message: "no" } },
          }),
        }),
      };
    }
    if (table === "contractor_applications") {
      return {
        select: () => ({
          eq: () => ({
            single: async () =>
              state.contractor ? { data: state.contractor, error: null } : { data: null, error: { message: "no" } },
          }),
        }),
      };
    }
    if (table === "sent_client_reminders") {
      return {
        insert: async (row: { job_id: string; reminder_type: string }) => {
          calls.insert += 1;
          calls.inserts.push(row);
          if (state.insertError) return { data: null, error: state.insertError };
          const key = `${row.job_id}::${row.reminder_type}`;
          if (ledger.has(key)) {
            return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
          }
          ledger.add(key);
          return { data: null, error: null };
        },
      };
    }
    throw new Error(`Unexpected table ${table}`);
  };
  return { from, calls, ledger } as any;
}

function mkResend(options: { failOnce?: boolean } = {}) {
  const sent: any[] = [];
  let shouldFail = options.failOnce || false;
  const client = {
    emails: {
      send: vi.fn(async (args: any) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Resend boom");
        }
        sent.push(args);
        return { id: "sent-1" };
      }),
    },
  };
  return { client, sent };
}

function mkReq(body: any, headers: Record<string, string | undefined> = {}): Request {
  return { body, headers } as any;
}

const INTERNAL_SECRET = "shhh";

function baseJob() {
  return {
    id: "job-123",
    slot_start_at: "2026-04-20T15:00:00.000Z",
    service_address: "123 Main St, Ottawa",
    prep_instructions: "Please keep cat in bedroom.",
    customer_id: "cust-1",
    contractor_id: "ctr-1",
  };
}

function mkDeps(overrides: Partial<SendClientReminderDeps> & { supa?: any } = {}): SendClientReminderDeps & { _supa: any; _sent: any[] } {
  const supa =
    overrides.supa ||
    mkSupabase({
      job: baseJob(),
      customer: { first_name: "Hermione", email: "hg@example.com" },
      contractor: { full_name: "Luna Lovegood" },
    });
  const { client, sent } = mkResend();
  return {
    supabase: supa,
    resend: overrides.resend ?? client,
    internalSecret: overrides.internalSecret ?? INTERNAL_SECRET,
    fromEmail: "Harry Spotter Cleaning Co. <magic@harryspottercleaning.ca>",
    _supa: supa,
    _sent: sent,
  } as any;
}

describe("sendClientReminder — idempotency", () => {
  it("double-call with same job_id returns 200 but only sends once", async () => {
    const deps = mkDeps();
    const first = await sendClientReminder(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": INTERNAL_SECRET }),
      deps,
    );
    const second = await sendClientReminder(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": INTERNAL_SECRET }),
      deps,
    );
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ sent: true, reminder_type: "initial" });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ sent: false, reason: "already_sent" });
    expect(deps._sent.length).toBe(1);
  });

  it("stamps reminder_sent_at BEFORE sending (idempotency fence)", async () => {
    const deps = mkDeps();
    await sendClientReminder(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": INTERNAL_SECRET }),
      deps,
    );
    expect(deps._supa.calls.jobsUpdate).toBe(1);
    expect(deps._supa.calls.lastJobsUpdatePayload.reminder_sent_at).toEqual(expect.any(String));
  });
});

describe("sendClientReminder — internal secret gate", () => {
  it("returns 401 with wrong secret", async () => {
    const deps = mkDeps();
    const res = await sendClientReminder(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": "wrong" }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(deps._sent.length).toBe(0);
  });

  it("returns 401 with no secret header", async () => {
    const deps = mkDeps();
    const res = await sendClientReminder(mkReq({ job_id: "job-123" }), deps);
    expect(res.status).toBe(401);
  });
});

describe("sendClientReminder — Resend failure", () => {
  it("Resend failure does NOT reset the ledger (no duplicate send on retry)", async () => {
    const supa = mkSupabase({
      job: baseJob(),
      customer: { first_name: "Harry", email: "h@example.com" },
      contractor: { full_name: "Hagrid" },
    });
    const { client: failingClient } = mkResend({ failOnce: true });
    const { client: okClient, sent: okSent } = mkResend();

    const first = await sendClientReminder(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": INTERNAL_SECRET }),
      { supabase: supa, resend: failingClient, internalSecret: INTERNAL_SECRET },
    );
    expect(first.status).toBe(502);
    expect(first.body.reason).toBe("resend_failed");

    // Retry with a healthy Resend client — ledger should already hold the
    // slot, so the retry must NOT send a new email.
    const retry = await sendClientReminder(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": INTERNAL_SECRET }),
      { supabase: supa, resend: okClient, internalSecret: INTERNAL_SECRET },
    );
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ sent: false, reason: "already_sent" });
    expect(okSent.length).toBe(0);
  });
});

describe("sendClientReminderUpdate", () => {
  it("renders the update email and uses reminder_type='update'", async () => {
    const deps = mkDeps();
    const res = await sendClientReminderUpdate(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": INTERNAL_SECRET }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, reminder_type: "update" });
    expect(deps._sent[0].subject).toMatch(/Update: your cleaning appointment details changed/);
    expect(deps._supa.calls.inserts[0].reminder_type).toBe("update");
  });

  it("is independently idempotent from the initial reminder", async () => {
    const deps = mkDeps();
    const a = await sendClientReminder(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": INTERNAL_SECRET }),
      deps,
    );
    const b = await sendClientReminderUpdate(
      mkReq({ job_id: "job-123" }, { "x-internal-secret": INTERNAL_SECRET }),
      deps,
    );
    expect(a.body).toEqual({ sent: true, reminder_type: "initial" });
    expect(b.body).toEqual({ sent: true, reminder_type: "update" });
    expect(deps._sent.length).toBe(2);
  });
});

describe("renderClientReminder template", () => {
  it("uses first-name greeting when available", () => {
    const out = renderClientReminder({
      clientFirstName: "Hermione",
      contractorName: "Luna",
      slotStartAt: "2026-04-20T15:00:00.000Z",
      serviceAddress: "123 Main St",
      prepInstructions: null,
    });
    expect(out.subject).toBe("Reminder: your cleaning is tomorrow");
    expect(out.html).toContain("Hi Hermione");
    expect(out.text).toContain("Hi Hermione");
    expect(out.replyTo).toBe("admin@harryspottercleaning.ca");
    expect(out.html).toContain("Luna");
    expect(out.html).toContain("123 Main St");
  });

  it("falls back to 'Hi there' when first name missing", () => {
    const out = renderClientReminder({
      clientFirstName: null,
      contractorName: "Luna",
      slotStartAt: "2026-04-20T15:00:00.000Z",
      serviceAddress: "123 Main St",
    });
    expect(out.html).toContain("Hi there");
    expect(out.text.startsWith("Hi there")).toBe(true);
  });

  it("includes prep instructions only when provided", () => {
    const withPrep = renderClientReminder({
      clientFirstName: "X",
      contractorName: "Y",
      slotStartAt: "2026-04-20T15:00:00.000Z",
      serviceAddress: "Z",
      prepInstructions: "Crate the dog please",
    });
    expect(withPrep.html).toContain("Crate the dog please");
    expect(withPrep.text).toContain("Crate the dog please");

    const noPrep = renderClientReminder({
      clientFirstName: "X",
      contractorName: "Y",
      slotStartAt: "2026-04-20T15:00:00.000Z",
      serviceAddress: "Z",
    });
    expect(noPrep.html).not.toContain("prep notes");
  });
});

describe("renderClientReminderUpdate template", () => {
  it("has the update subject + 'cleaner has been updated' copy", () => {
    const out = renderClientReminderUpdate({
      clientFirstName: "Harry",
      contractorName: "Hagrid",
      slotStartAt: "2026-04-20T15:00:00.000Z",
      serviceAddress: "4 Privet Dr",
    });
    expect(out.subject).toBe("Update: your cleaning appointment details changed");
    expect(out.html).toContain("cleaner has been updated");
    expect(out.text).toContain("cleaner has been updated");
  });
});

// ── Admin notification helper ─────────────────────────────────────────────────

describe("sendManualAssignmentNeededNotification", () => {
  beforeEach(() => {
    process.env.ADMIN_BOOKING_NOTIFICATIONS_ENABLED = "true";
  });

  it("composes subject + html + text with job details", () => {
    const rendered = renderManualAssignmentNeededNotification({
      id: "abcdef12-3456",
      slot_start_at: "2026-04-20T15:00:00.000Z",
      service_address: "42 Diagon Alley",
      client_name: "Harry Potter",
      client_email: "harry@example.com",
      pets_in_home: true,
    });
    expect(rendered.subject).toMatch(/^⚠️ Manual assignment needed — Job abcdef12/);
    expect(rendered.html).toContain("42 Diagon Alley");
    expect(rendered.html).toContain("Harry Potter");
    expect(rendered.text).toContain("Pets in home: Yes");
    expect(rendered.text).toContain("No compatible contractor");
  });

  it("sends via the shared resend client when enabled", async () => {
    const { client, sent } = mkResend();
    const result = await sendManualAssignmentNeededNotification(client as any, {
      id: "job-xyz",
      slot_start_at: "2026-04-20T15:00:00.000Z",
      service_address: "Addr",
      client_name: "C",
      pets_in_home: false,
    });
    expect(result.sent).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("magic@harryspottercleaning.ca");
    expect(sent[0].subject).toMatch(/Manual assignment needed/);
  });

  it("is skipped when ADMIN_BOOKING_NOTIFICATIONS_ENABLED is off", async () => {
    process.env.ADMIN_BOOKING_NOTIFICATIONS_ENABLED = "false";
    const { client, sent } = mkResend();
    const result = await sendManualAssignmentNeededNotification(client as any, {
      id: "job-xyz",
      pets_in_home: null,
    });
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe("disabled");
    expect(sent.length).toBe(0);
  });

  it("returns error string and does not throw when Resend rejects", async () => {
    const client = {
      emails: {
        send: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
    };
    const result = await sendManualAssignmentNeededNotification(client as any, {
      id: "job-xyz",
      pets_in_home: true,
    });
    expect(result.sent).toBe(false);
    expect(result.error).toBe("network down");
  });
});
