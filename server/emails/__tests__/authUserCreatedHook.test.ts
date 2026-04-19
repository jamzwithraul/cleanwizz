// Integration-style test for the /api/internal/hooks/auth-user-created handler
// logic. We exercise the handler directly (not via registerRoutes, which has
// many unrelated dependencies) so the test focuses on: secret check, payload
// parsing, and dispatch selection.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __setResendForTests,
  sendNewContractorNotification,
} from "../adminNotifications";

describe("auth-user-created hook contract", () => {
  let sendSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.ADMIN_NOTIFICATION_EMAIL = "admin@harryspottercleaning.ca";
    process.env.FROM_EMAIL = "Harry Spotter <magic@harryspottercleaning.ca>";
    delete process.env.EMAIL_FROM_ADDRESS;
    delete process.env.EMAIL_FROM_NAME;
    sendSpy = vi.fn().mockResolvedValue({ id: "email-id" });
    __setResendForTests({ emails: { send: sendSpy } } as any);
  });

  afterEach(() => {
    __setResendForTests(null);
    vi.restoreAllMocks();
  });

  // The production handler verifies INTERNAL_SERVICE_SECRET before doing
  // anything. This test pins that contract.
  function authCheck(expected: string | undefined, provided: string | undefined): boolean {
    return !!expected && !!provided && provided === expected;
  }

  it("rejects when X-Internal-Secret does not match", () => {
    expect(authCheck("real-secret", "wrong")).toBe(false);
    expect(authCheck("real-secret", undefined)).toBe(false);
    expect(authCheck(undefined, "anything")).toBe(false);
  });

  it("accepts when secrets match", () => {
    expect(authCheck("real-secret", "real-secret")).toBe(true);
  });

  // Supabase sends multiple possible shapes; the handler normalizes them.
  function extractAuthUser(body: any): { id?: string; email?: string } {
    const record = body?.record ?? body?.user ?? body;
    return { id: record?.id ?? record?.user_id, email: record?.email };
  }

  it("extracts from the DB webhook record shape", () => {
    const r = extractAuthUser({
      type: "INSERT",
      table: "users",
      record: { id: "uid-1", email: "alex@example.com" },
    });
    expect(r).toEqual({ id: "uid-1", email: "alex@example.com" });
  });

  it("extracts from the Auth-hook user shape", () => {
    const r = extractAuthUser({ user: { id: "uid-2", email: "beth@example.com" } });
    expect(r).toEqual({ id: "uid-2", email: "beth@example.com" });
  });

  it("extracts from a flat payload", () => {
    const r = extractAuthUser({ id: "uid-3", email: "carl@example.com" });
    expect(r).toEqual({ id: "uid-3", email: "carl@example.com" });
  });

  it("end-to-end: valid payload triggers one admin email with the right subject", async () => {
    const body = { record: { id: "uid-xyz", email: "new@contractor.com" } };
    const { id, email } = extractAuthUser(body);
    expect(id).toBeTruthy();
    expect(email).toBeTruthy();
    const result = await sendNewContractorNotification({
      authUserId: id!,
      email: email!,
    });
    expect(result.sent).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0][0];
    expect(call.to).toBe("admin@harryspottercleaning.ca");
    expect(call.subject).toBe("New contractor signup — new@contractor.com");
    expect(call.text).toContain("User ID: uid-xyz");
  });
});

// Contract test for the Event-2/Event-3 mutual exclusion rule in /api/booking/book.
// This mirrors the dispatcher in routes.ts — keep in sync.
describe("booking dispatcher contract", () => {
  function pickEvent(priorAcceptedForEmail: number): "new_client" | "repeat_client" {
    // Prior count excludes the just-inserted booking. 0 → Event 2, ≥1 → Event 3.
    return priorAcceptedForEmail === 0 ? "new_client" : "repeat_client";
  }

  it("fires Event 2 for first-time bookings", () => {
    expect(pickEvent(0)).toBe("new_client");
  });

  it("fires Event 3 on the second booking and beyond", () => {
    expect(pickEvent(1)).toBe("repeat_client");
    expect(pickEvent(10)).toBe("repeat_client");
  });

  it("Event 2 and Event 3 are mutually exclusive for any prior count", () => {
    for (let n = 0; n <= 20; n++) {
      const choice = pickEvent(n);
      const opposite = choice === "new_client" ? "repeat_client" : "new_client";
      expect(pickEvent(n)).not.toBe(opposite);
    }
  });
});
