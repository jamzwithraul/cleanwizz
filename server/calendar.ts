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
// Mon–Sat, 8am–8pm Eastern.
const BUSINESS_HOURS = { start: 8, end: 20 }; // 24h
const SLOT_DURATION_HOURS = 2; // each cleaning slot is 2 hours
const DAYS_AHEAD = 14; // show availability 2 weeks out
const WORKING_DAYS = [1, 2, 3, 4, 5, 6]; // Mon=1 … Sat=6 (0=Sun)

// ── Get available slots ───────────────────────────────────────────────────────
export async function getAvailableSlots(): Promise<{ start: string; end: string; label: string }[]> {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setHours(timeMin.getHours() + 24); // earliest = tomorrow
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + DAYS_AHEAD);

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
  const slots: { start: string; end: string; label: string }[] = [];

  // Iterate day by day over the window
  const cursorDate = new Date(timeMin);
  // Reset to midnight Eastern of the next day
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

    for (let h = BUSINESS_HOURS.start; h + SLOT_DURATION_HOURS <= BUSINESS_HOURS.end; h++) {
      // Build ISO string in ET
      const hStr  = String(h).padStart(2, "0");
      const h2Str = String(h + SLOT_DURATION_HOURS).padStart(2, "0");
      const slotStart = new Date(`${etYear}-${etMonth}-${etDay}T${hStr}:00:00-04:00`);
      const slotEnd   = new Date(`${etYear}-${etMonth}-${etDay}T${h2Str}:00:00-04:00`);

      // Skip past slots
      if (slotStart <= now) continue;

      // Skip weekends (check ET day of week)
      const etDow = slotStart.toLocaleDateString("en-CA", { timeZone: "America/Toronto", weekday: "short" });
      if (etDow === "Sun") continue;

      // Check overlap with busy blocks
      const isBusy = busyBlocks.some(b => slotStart < b.end && slotEnd > b.start);
      if (!isBusy) {
        const label = slotStart.toLocaleString("en-CA", {
          timeZone: "America/Toronto",
          weekday: "short",
          month:   "short",
          day:     "numeric",
          hour:    "numeric",
          minute:  "2-digit",
          hour12:  true,
        });
        slots.push({
          start: slotStart.toISOString(),
          end:   slotEnd.toISOString(),
          label,
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
      summary: `🧹 Clean Wizz — ${opts.clientName}`,
      description: [
        `Quote ID: ${opts.quoteId}`,
        `Service: ${opts.serviceType}`,
        `Total: $${opts.total.toFixed(2)} CAD`,
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
