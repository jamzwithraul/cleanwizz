/**
 * Booking helpers — server-side validation + booking reference codes.
 *
 * Shared by POST /api/booking/book and the unit tests.
 */

import { getAvailableSlots, type SlotInfo } from "./calendar";

export const BOOKING_BUFFER_HOURS = 48;

export interface SlotInput {
  start: string;
  end: string;
}

export type SlotValidationError =
  | { kind: "buffer_violation"; slot: SlotInput; reason: string }
  | { kind: "slot_unavailable"; slot: SlotInput; reason: string }
  | { kind: "invalid_slot"; slot: SlotInput; reason: string };

/**
 * Enforce the 48-hour booking buffer against `now`. Pure — no I/O.
 */
export function validateBuffer(
  slot: SlotInput,
  now: Date = new Date(),
  bufferHours: number = BOOKING_BUFFER_HOURS,
): SlotValidationError | null {
  const startMs = Date.parse(slot.start);
  const endMs = Date.parse(slot.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return { kind: "invalid_slot", slot, reason: "Unparseable start/end" };
  }
  if (endMs <= startMs) {
    return { kind: "invalid_slot", slot, reason: "end must be after start" };
  }
  const cutoff = now.getTime() + bufferHours * 60 * 60 * 1000;
  if (startMs < cutoff) {
    return {
      kind: "buffer_violation",
      slot,
      reason: `Slot starts before ${bufferHours}h buffer`,
    };
  }
  return null;
}

/**
 * Check a slot against the live calendar availability feed. Returns the
 * matching SlotInfo if open, or a validation error otherwise.
 */
export function findOpenSlot(
  slot: SlotInput,
  available: SlotInfo[],
): { ok: true; slot: SlotInfo } | { ok: false; err: SlotValidationError } {
  // Match on start only. The available[] feed emits canonical 2-hour windows
  // (SLOT_DURATION_HOURS in calendar.ts), but actual job duration depends on
  // service type (Standard=4h, Deep=6h, Move-out=8h, Micro=2h). The frontend
  // sends `end` reflecting the real job duration, which would never match the
  // 2-hour grid. Slot start uniquely identifies the booking anchor; the route
  // handler uses the caller-supplied end when creating the Google Calendar
  // event so the full job duration is blocked.
  const startIso = new Date(slot.start).toISOString();
  const match = available.find(
    (s) => new Date(s.start).toISOString() === startIso,
  );
  if (!match) {
    return {
      ok: false,
      err: {
        kind: "slot_unavailable",
        slot,
        reason: "No matching slot in calendar",
      },
    };
  }
  if (match.status !== "available") {
    return {
      ok: false,
      err: {
        kind: "slot_unavailable",
        slot,
        reason: `Slot status is ${match.status}`,
      },
    };
  }
  return { ok: true, slot: match };
}

/**
 * Validate an array of booking slots — buffer + calendar availability.
 * Short-circuits on the first failure (enough info for a 400/409).
 */
export async function validateBookingSlots(
  slots: SlotInput[],
  opts: { now?: Date; available?: SlotInfo[] } = {},
): Promise<{ ok: true; slots: SlotInfo[] } | { ok: false; err: SlotValidationError }> {
  if (!Array.isArray(slots) || slots.length === 0) {
    return {
      ok: false,
      err: {
        kind: "invalid_slot",
        slot: { start: "", end: "" },
        reason: "slots[] is required and must be non-empty",
      },
    };
  }

  const now = opts.now ?? new Date();
  for (const s of slots) {
    const err = validateBuffer(s, now);
    if (err) return { ok: false, err };
  }

  const available = opts.available ?? (await getAvailableSlots());
  const resolved: SlotInfo[] = [];
  for (const s of slots) {
    const check = findOpenSlot(s, available);
    if (!check.ok) return check;
    // Preserve caller-supplied end so the route handler can block the actual
    // job duration (e.g. 4h for Standard) on Google Calendar, not the 2h grid.
    resolved.push({ ...check.slot, end: new Date(s.end).toISOString() });
  }
  return { ok: true, slots: resolved };
}

// ── Booking reference code ──────────────────────────────────────────────────
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function generateBookingReference(
  now: Date = new Date(),
  rand: () => number = Math.random,
): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += REF_ALPHABET[Math.floor(rand() * REF_ALPHABET.length)];
  }
  return `HS-${yyyy}${mm}${dd}-${suffix}`;
}
