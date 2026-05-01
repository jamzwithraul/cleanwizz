/**
 * Clean Wizz — Google Calendar Integration
 *
 * Uses a Service Account to read free/busy and create booking events
 * on the dedicated "Clean Wizz" calendar.
 */

import { google } from "googleapis";

const CALENDAR_ID = "23620c59618f14bc6a65060bf77f9a38f1912e774a9c453468670b79c01f9e43@group.calendar.google.com";

// ── Auth ──────────────────────────────────────────────────────────────────────
function getAuth() {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var not set");

  // Strip surrounding single-quotes that some env loaders preserve from .env files
  const cleanKey = key.replace(/^'|'$/g, '');
  const credentials = JSON.parse(cleanKey);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

// ── Business hours config ─────────────────────────────────────────────────────
// Mon–Sat, two booking windows: 8–11 AM and 1–5 PM Eastern.
// Site posted hours are 8 AM – 8 PM but bookable slots use these windows.
const SLOT_WINDOWS = [
  { start: 8, end: 11 },  // morning block
  { start: 13, end: 19 }, // afternoon block (last 2-hr slot starts at 5 PM, ends 7 PM)
];
const SLOT_DURATION_HOURS = 2; // each cleaning slot is 2 hours
const DAYS_AHEAD = 60; // booking window — match frontend calendar widget (60 days)
const WORKING_DAYS = [1, 2, 3, 4, 5, 6]; // Mon=1 … Sat=6 (0=Sun)

// ── Slot status ──────────────────────────────────────────────────────────────
export type SlotStatus = "available" | "booked" | "blocked";
export interface SlotInfo {
  start: string;
  end: string;
  label: string;
  date: string;       // YYYY-MM-DD in ET
  hour: number;       // start hour in ET (e.g. 8, 9, 13, 14…)
  dayOfWeek: number;  // 0=Sun, 1=Mon … 6=Sat
  status: SlotStatus; // available, booked (Google Cal), blocked (business rule)
}

// ── Get available slots ───────────────────────────────────────────────────────
export async function getAvailableSlots(): Promise<SlotInfo[]> {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setHours(timeMin.getHours() + 48); // earliest bookable = 48 hours from now
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + DAYS_AHEAD);

  // 48-hour buffer: any slot starting before this is unavailable.
  const bufferCutoff = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  // Fetch existing events to find busy times
  const eventsRes = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const busyBlocks = (eventsRes.data.items || []).map(e => ({
    start: new Date(e.start?.dateTime || e.start?.date || ""),
    end:   new Date(e.end?.dateTime   || e.end?.date   || ""),
  }));

  // Generate candidate slots in Eastern Time
  const slots: SlotInfo[] = [];

  const etFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit",
  });

  // Build slots by constructing ET datetime strings
  for (let d = 0; d < DAYS_AHEAD; d++) {
    const dayOffset = new Date(now);
    dayOffset.setDate(dayOffset.getDate() + d + 1);

    // Get the date parts in ET
    const etParts = etFormatter.formatToParts(dayOffset);
    const etYear  = etParts.find(p => p.type === "year")!.value;
    const etMonth = etParts.find(p => p.type === "month")!.value;
    const etDay   = etParts.find(p => p.type === "day")!.value;
    const dateStr = `${etYear}-${etMonth}-${etDay}`;

    for (const window of SLOT_WINDOWS) {
      for (let h = window.start; h + SLOT_DURATION_HOURS <= window.end; h++) {
        // Build ISO string in ET
        const hStr  = String(h).padStart(2, "0");
        const h2Str = String(h + SLOT_DURATION_HOURS).padStart(2, "0");
        const slotStart = new Date(`${etYear}-${etMonth}-${etDay}T${hStr}:00:00-04:00`);
        const slotEnd   = new Date(`${etYear}-${etMonth}-${etDay}T${h2Str}:00:00-04:00`);

        // Skip slots that fall inside the 48-hour booking buffer (covers both
        // past slots and anything less than 48h from "now").
        if (slotStart <= bufferCutoff) continue;

        // Skip Sundays (check ET day of week)
        const etDow = slotStart.toLocaleDateString("en-CA", { timeZone: "America/Toronto", weekday: "short" });
        if (etDow === "Sun") continue;

        // Determine day of week (0=Sun … 6=Sat)
        const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(etDow);

        const label = slotStart.toLocaleString("en-CA", {
          timeZone: "America/Toronto",
          weekday: "short",
          month:   "short",
          day:     "numeric",
          hour:    "numeric",
          minute:  "2-digit",
          hour12:  true,
        });

        // Determine status: business rule first, then Google Calendar
        let status: SlotStatus = "available";

        // Business rule: Mon–Fri slots starting before 4 PM are blocked
        if (dayOfWeek >= 1 && dayOfWeek <= 5 && h < 16) {
          status = "blocked";
        }

        // Google Calendar: check overlap with busy blocks
        if (status === "available") {
          const isBusy = busyBlocks.some(b => slotStart < b.end && slotEnd > b.start);
          if (isBusy) status = "booked";
        }

        slots.push({
          start: slotStart.toISOString(),
          end:   slotEnd.toISOString(),
          label,
          date: dateStr,
          hour: h,
          dayOfWeek,
          status,
        });
      }
    }
  }

  return slots;
}

// ── Book a slot ───────────────────────────────────────────────────────────────
export async function bookSlot(opts: {
  start: string;
  end:   string;
  clientName:    string;
  clientEmail:   string;
  clientPhone:   string;
  clientAddress: string;
  serviceType:   string;
  total:         number;
  quoteId:       string;
}): Promise<string> {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const event = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `🧹 Harriet's Spotless booking — ${opts.serviceType} (${opts.clientName})`,
      description: [
        `Harriet's Spotless Cleaning Co.`,
        `Quote ID: ${opts.quoteId}`,
        `Service: ${opts.serviceType}`,
        `Total: $${opts.total.toFixed(2)} CAD`,
        `Client: ${opts.clientName}`,
        `Address: ${opts.clientAddress}`,
        `Phone: ${opts.clientPhone}`,
        `Email: ${opts.clientEmail}`,
      ].join("\n"),
      location: opts.clientAddress,
      start: { dateTime: opts.start, timeZone: "America/Toronto" },
      end:   { dateTime: opts.end,   timeZone: "America/Toronto" },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 24 * 60 },
          { method: "popup", minutes: 60 },
        ],
      },
    },
  });

  return event.data.htmlLink || "";
}

// ── Availability blocks ──────────────────────────────────────────────────────
// Blocks are Google Calendar events whose summary starts with "[BLOCK]".
// They share the same calendar as real bookings, so the existing busyBlocks
// overlap check in getAvailableSlots() already makes blocked slots show as
// "booked" without any modification to the slot generator.
const BLOCK_PREFIX = "[BLOCK]";

export interface BlockEvent {
  id: string;
  summary: string;
  reason: string;
  allDay: boolean;
  start: string; // ISO for timed, YYYY-MM-DD for all-day
  end: string;   // ISO for timed, YYYY-MM-DD for all-day (exclusive)
  htmlLink: string;
}

function toBlockEvent(e: any): BlockEvent {
  const summary: string = e.summary || "";
  const reason = summary.startsWith(BLOCK_PREFIX)
    ? summary.slice(BLOCK_PREFIX.length).trim()
    : summary;
  const allDay = !!e.start?.date;
  return {
    id: e.id,
    summary,
    reason,
    allDay,
    start: allDay ? e.start.date : e.start.dateTime,
    end:   allDay ? e.end.date   : e.end.dateTime,
    htmlLink: e.htmlLink || "",
  };
}

export async function listBlocks(): Promise<BlockEvent[]> {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setDate(timeMin.getDate() - 1); // include today
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + DAYS_AHEAD + 30);

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    q: BLOCK_PREFIX,
  });

  return (res.data.items || [])
    .filter(e => (e.summary || "").startsWith(BLOCK_PREFIX))
    .map(toBlockEvent);
}

export async function createBlock(opts: {
  reason: string;
  allDay: boolean;
  date: string;          // YYYY-MM-DD (ET)
  startHour?: number;    // 0-23, required when !allDay
  endHour?: number;      // 0-23, required when !allDay
}): Promise<BlockEvent> {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const summary = `${BLOCK_PREFIX} ${opts.reason}`.trim();

  let requestBody: any;
  if (opts.allDay) {
    // All-day event — Google uses exclusive end date
    const startDate = opts.date;
    const endDateObj = new Date(`${opts.date}T00:00:00Z`);
    endDateObj.setUTCDate(endDateObj.getUTCDate() + 1);
    const endDate = endDateObj.toISOString().slice(0, 10);
    requestBody = {
      summary,
      start: { date: startDate },
      end:   { date: endDate },
    };
  } else {
    if (opts.startHour == null || opts.endHour == null) {
      throw new Error("startHour and endHour required for timed block");
    }
    if (opts.endHour <= opts.startHour) {
      throw new Error("endHour must be greater than startHour");
    }
    const sh = String(opts.startHour).padStart(2, "0");
    const eh = String(opts.endHour).padStart(2, "0");
    requestBody = {
      summary,
      start: { dateTime: `${opts.date}T${sh}:00:00`, timeZone: "America/Toronto" },
      end:   { dateTime: `${opts.date}T${eh}:00:00`, timeZone: "America/Toronto" },
    };
  }

  const event = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody,
  });

  return toBlockEvent(event.data);
}

export async function deleteBlock(eventId: string): Promise<void> {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  // Safety: verify the event is actually a block before deleting
  const existing = await calendar.events.get({
    calendarId: CALENDAR_ID,
    eventId,
  });
  const summary = existing.data.summary || "";
  if (!summary.startsWith(BLOCK_PREFIX)) {
    throw new Error("Refusing to delete: event is not an availability block");
  }

  await calendar.events.delete({
    calendarId: CALENDAR_ID,
    eventId,
  });
}
