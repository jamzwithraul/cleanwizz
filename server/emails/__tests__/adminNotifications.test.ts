import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildNewContractorEmail,
  buildNewClientBookingEmail,
  buildRepeatClientBookingEmail,
  sendNewContractorNotification,
  sendNewClientBookingNotification,
  sendRepeatClientBookingNotification,
  getAdminEmail,
  getFromEmail,
  __setResendForTests,
} from "../adminNotifications";

// ── Pure builders ────────────────────────────────────────────────────────────
describe("buildNewContractorEmail", () => {
  it("produces the spec subject and body", () => {
    const { subject, text } = buildNewContractorEmail({
      email: "alex@example.com",
      authUserId: "uuid-123",
      timestamp: new Date("2026-04-19T14:30:00Z"),
    });
    expect(subject).toBe("New contractor signup — alex@example.com");
    expect(text).toContain("Email: alex@example.com");
    expect(text).toContain("User ID: uuid-123");
    expect(text).toContain("America/Toronto");
    expect(text).toContain("Next step: they'll complete the contractor application");
    expect(text).toContain("— Harry Spotter Cleaning Co. system");
  });
});

describe("buildNewClientBookingEmail", () => {
  const base = {
    email: "jane@example.com",
    name: "Jane Doe",
    referenceCode: "HS-20260419-ABC123",
    serviceType: "Deep Clean",
    total: 249.5,
    address: "123 Elm St, Ottawa, ON",
    appointmentStart: "2026-05-01T14:00:00-04:00",
    slotCount: 1,
  };

  it("renders single-session appointment", () => {
    const { subject, text } = buildNewClientBookingEmail(base);
    expect(subject).toBe("New client — first booking from jane@example.com");
    expect(text).toContain("Client email: jane@example.com");
    expect(text).toContain("Client name: Jane Doe");
    expect(text).toContain("Booking reference: HS-20260419-ABC123");
    expect(text).toContain("Service: Deep Clean");
    expect(text).toContain("Total: $249.50");
    expect(text).toContain("Address: 123 Elm St, Ottawa, ON");
    expect(text).toMatch(/Appointment: [A-Za-z]+, [A-Za-z]+ \d+/);
  });

  it("renders multi-session when slotCount > 1", () => {
    const { text } = buildNewClientBookingEmail({ ...base, slotCount: 3 });
    expect(text).toContain("Appointment: multi-session");
  });

  it("renders multi-session when appointmentStart is missing", () => {
    const { text } = buildNewClientBookingEmail({ ...base, appointmentStart: null });
    expect(text).toContain("Appointment: multi-session");
  });

  it("formats total with 2 decimals", () => {
    const { text } = buildNewClientBookingEmail({ ...base, total: 100 });
    expect(text).toContain("Total: $100.00");
  });
});

describe("buildRepeatClientBookingEmail", () => {
  it("includes total bookings count in subject and body", () => {
    const { subject, text } = buildRepeatClientBookingEmail({
      email: "jane@example.com",
      name: "Jane Doe",
      referenceCode: "HS-20260419-XYZ999",
      serviceType: "Standard",
      total: 180,
      address: "456 Oak Ave",
      appointmentStart: "2026-05-02T10:00:00-04:00",
      slotCount: 1,
      totalBookings: 4,
    });
    expect(subject).toBe("Repeat client booking — jane@example.com (#4)");
    expect(text).toContain("Total bookings by this client: 4");
    expect(text).toContain("A returning client just booked again.");
  });
});

// ── Env / config helpers ────────────────────────────────────────────────────
describe("getAdminEmail", () => {
  const orig = process.env.ADMIN_NOTIFICATION_EMAIL;
  afterEach(() => { process.env.ADMIN_NOTIFICATION_EMAIL = orig; });

  it("defaults to admin@harryspottercleaning.ca", () => {
    delete process.env.ADMIN_NOTIFICATION_EMAIL;
    expect(getAdminEmail()).toBe("admin@harryspottercleaning.ca");
  });

  it("honors the env var override", () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = "ops@example.com";
    expect(getAdminEmail()).toBe("ops@example.com");
  });
});

describe("getFromEmail", () => {
  const origFrom = process.env.FROM_EMAIL;
  const origAddr = process.env.EMAIL_FROM_ADDRESS;
  const origName = process.env.EMAIL_FROM_NAME;
  afterEach(() => {
    process.env.FROM_EMAIL = origFrom;
    process.env.EMAIL_FROM_ADDRESS = origAddr;
    process.env.EMAIL_FROM_NAME = origName;
  });

  it("prefers EMAIL_FROM_ADDRESS + EMAIL_FROM_NAME", () => {
    delete process.env.FROM_EMAIL;
    process.env.EMAIL_FROM_ADDRESS = "noreply@harryspottercleaning.ca";
    process.env.EMAIL_FROM_NAME = "Harry Spotter";
    expect(getFromEmail()).toBe("Harry Spotter <noreply@harryspottercleaning.ca>");
  });

  it("falls back to FROM_EMAIL", () => {
    delete process.env.EMAIL_FROM_ADDRESS;
    delete process.env.EMAIL_FROM_NAME;
    process.env.FROM_EMAIL = "magic@harryspottercleaning.ca";
    expect(getFromEmail()).toBe("magic@harryspottercleaning.ca");
  });
});

// ── Send path (mocked Resend) ───────────────────────────────────────────────
describe("send helpers with mocked Resend", () => {
  let sendSpy: ReturnType<typeof vi.fn>;
  const origKey = process.env.RESEND_API_KEY;
  const origAdmin = process.env.ADMIN_NOTIFICATION_EMAIL;
  const origFrom = process.env.FROM_EMAIL;

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
    process.env.RESEND_API_KEY = origKey;
    process.env.ADMIN_NOTIFICATION_EMAIL = origAdmin;
    process.env.FROM_EMAIL = origFrom;
    vi.restoreAllMocks();
  });

  it("sendNewContractorNotification hits Resend with correct to/subject/text", async () => {
    const result = await sendNewContractorNotification({
      email: "new@contractor.com",
      authUserId: "auth-uid-1",
    });
    expect(result.sent).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0][0];
    expect(call.to).toBe("admin@harryspottercleaning.ca");
    expect(call.from).toBe("Harry Spotter <magic@harryspottercleaning.ca>");
    expect(call.subject).toBe("New contractor signup — new@contractor.com");
    expect(call.text).toContain("Email: new@contractor.com");
    expect(call.text).toContain("User ID: auth-uid-1");
    expect(call.html).toContain("new@contractor.com");
  });

  it("sendNewClientBookingNotification sends Event 2 payload", async () => {
    const result = await sendNewClientBookingNotification({
      email: "jane@example.com",
      name: "Jane Doe",
      referenceCode: "HS-20260419-ABC123",
      serviceType: "Deep Clean",
      total: 249.5,
      address: "123 Elm St",
      appointmentStart: "2026-05-01T14:00:00-04:00",
      slotCount: 1,
    });
    expect(result.sent).toBe(true);
    const call = sendSpy.mock.calls[0][0];
    expect(call.subject).toBe("New client — first booking from jane@example.com");
    expect(call.text).toContain("Total: $249.50");
  });

  it("sendRepeatClientBookingNotification sends Event 3 payload with count", async () => {
    const result = await sendRepeatClientBookingNotification({
      email: "jane@example.com",
      name: "Jane Doe",
      referenceCode: "HS-20260419-XYZ999",
      serviceType: "Standard",
      total: 180,
      address: "456 Oak Ave",
      appointmentStart: "2026-05-02T10:00:00-04:00",
      slotCount: 1,
      totalBookings: 5,
    });
    expect(result.sent).toBe(true);
    const call = sendSpy.mock.calls[0][0];
    expect(call.subject).toBe("Repeat client booking — jane@example.com (#5)");
    expect(call.text).toContain("Total bookings by this client: 5");
  });

  it("skips send and logs a warning when RESEND_API_KEY is missing", async () => {
    __setResendForTests(null);
    delete process.env.RESEND_API_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await sendNewContractorNotification({
      email: "x@y.com",
      authUserId: "aaa",
    });
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe("no_api_key");
    expect(warn).toHaveBeenCalled();
  });

  it("swallows Resend errors and logs — never throws", async () => {
    sendSpy.mockRejectedValueOnce(new Error("Resend API down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendNewContractorNotification({
      email: "boom@example.com",
      authUserId: "uid-boom",
    });
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe("error");
    expect(err).toHaveBeenCalled();
  });

  it("honors ADMIN_NOTIFICATION_EMAIL override at send time", async () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = "ops@harryspottercleaning.ca";
    await sendNewContractorNotification({ email: "a@b.com", authUserId: "u" });
    expect(sendSpy.mock.calls[0][0].to).toBe("ops@harryspottercleaning.ca");
  });
});

// ── Event-selection logic (Event 2 vs Event 3 mutual exclusion) ─────────────
// Pure function mirror of the dispatch rule: 0 prior bookings → Event 2,
// ≥1 prior → Event 3. Keep this in sync with server/routes.ts booking path.
function selectBookingEvent(priorCount: number): "new_client" | "repeat_client" {
  return priorCount === 0 ? "new_client" : "repeat_client";
}

describe("booking event selection (Events 2 vs 3 mutual exclusion)", () => {
  it("picks new-client when there are zero prior bookings", () => {
    expect(selectBookingEvent(0)).toBe("new_client");
  });

  it("picks repeat-client on any prior count ≥1", () => {
    expect(selectBookingEvent(1)).toBe("repeat_client");
    expect(selectBookingEvent(2)).toBe("repeat_client");
    expect(selectBookingEvent(99)).toBe("repeat_client");
  });
});
