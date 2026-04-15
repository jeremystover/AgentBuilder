// Minimal iCalendar (RFC 5545) parser and generator sufficient for
// syncing booking calendars between Airbnb / VRBO / Booking.com and our
// own system.  We only care about VEVENT records with DTSTART / DTEND /
// UID / SUMMARY / DESCRIPTION.  Time-of-day is ignored - bookings are
// treated as all-day events on check-in / check-out dates.

export interface ICalEvent {
  uid: string;
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD (exclusive)
  summary?: string;
  description?: string;
  status?: string;
}

/** Unfold RFC 5545 continuation lines (lines starting with space or tab). */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Convert an iCal date/date-time value to YYYY-MM-DD. */
function toDate(value: string): string {
  // Strip any TZID-prefixed value. Accept YYYYMMDD or YYYYMMDDTHHMMSS[Z].
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) throw new Error(`Unparseable iCal date: ${value}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function splitProp(line: string): { name: string; params: Record<string, string>; value: string } {
  const idx = line.indexOf(":");
  if (idx === -1) return { name: line, params: {}, value: "" };
  const head = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = head.split(";");
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq > -1) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

function unescape(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Parse an iCalendar document and return its VEVENTs. */
export function parseICal(text: string): ICalEvent[] {
  const lines = unfold(text);
  const events: ICalEvent[] = [];
  let cur: Partial<ICalEvent> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur && cur.uid && cur.start && cur.end) {
        events.push(cur as ICalEvent);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const { name, value } = splitProp(line);
    switch (name) {
      case "UID":         cur.uid = value.trim(); break;
      case "DTSTART":     cur.start = toDate(value); break;
      case "DTEND":       cur.end = toDate(value); break;
      case "SUMMARY":     cur.summary = unescape(value); break;
      case "DESCRIPTION": cur.description = unescape(value); break;
      case "STATUS":      cur.status = value.trim(); break;
    }
  }
  return events;
}

function pad(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function fmtIcalDate(isoDate: string): string {
  // YYYY-MM-DD -> YYYYMMDD
  return isoDate.replace(/-/g, "");
}

function fmtIcalDateTimeUTC(d: Date): string {
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function escapeText(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Fold a long line to max 75 octets as RFC 5545 requires. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  chunks.push(line.slice(0, 75));
  i = 75;
  while (i < line.length) {
    chunks.push(" " + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join("\r\n");
}

export interface ICalBuildEvent {
  uid: string;
  start: string; // YYYY-MM-DD (check-in)
  end: string;   // YYYY-MM-DD (checkout, exclusive)
  summary?: string;
  description?: string;
}

/** Build an iCalendar VCALENDAR document. */
export function buildICal(calendarName: string, events: ICalBuildEvent[]): string {
  const now = fmtIcalDateTimeUTC(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Booking Sync Manager//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    fold(`X-WR-CALNAME:${escapeText(calendarName)}`),
  ];
  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(fold(`UID:${ev.uid}`));
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART;VALUE=DATE:${fmtIcalDate(ev.start)}`);
    lines.push(`DTEND;VALUE=DATE:${fmtIcalDate(ev.end)}`);
    if (ev.summary)     lines.push(fold(`SUMMARY:${escapeText(ev.summary)}`));
    if (ev.description) lines.push(fold(`DESCRIPTION:${escapeText(ev.description)}`));
    lines.push("TRANSP:OPAQUE");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
