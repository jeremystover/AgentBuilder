/**
 * calendar.js — Google Calendar REST API client for Cloudflare Workers.
 *
 * Full read+write access using OAuth2 user tokens (createUserFetch).
 * The user must run bin/google-auth once with the calendar scope.
 *
 * Factory: createCalendar(ufetch) returns a Calendar operations object.
 */

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

export function createCalendar(ufetch) {

  // ── List calendars ────────────────────────────────────────────────────────

  async function listCalendars() {
    const res = await ufetch(`${CAL_BASE}/users/me/calendarList`);
    const data = await res.json();
    return data.items || [];
  }

  // ── List events ───────────────────────────────────────────────────────────

  async function listEvents(calendarId = "primary", {
    timeMin,
    timeMax,
    maxResults = 100,
    singleEvents = true,
    orderBy = "startTime",
    pageToken,
    q,
  } = {}) {
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      singleEvents: String(singleEvents),
      orderBy,
    });
    if (timeMin) params.set("timeMin", timeMin);
    if (timeMax) params.set("timeMax", timeMax);
    if (pageToken) params.set("pageToken", pageToken);
    if (q) params.set("q", q);

    const res = await ufetch(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`
    );
    const data = await res.json();
    return data.items || [];
  }

  // ── Get a single event ────────────────────────────────────────────────────

  async function getEvent(calendarId = "primary", eventId) {
    const res = await ufetch(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`
    );
    return res.json();
  }

  // ── Create an event ───────────────────────────────────────────────────────

  async function createEvent(calendarId = "primary", event) {
    const res = await ufetch(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }
    );
    return res.json();
  }

  // ── Update an event ───────────────────────────────────────────────────────

  async function updateEvent(calendarId = "primary", eventId, event) {
    const res = await ufetch(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }
    );
    return res.json();
  }

  // ── Patch an event (partial update) ──────────────────────────────────────

  async function patchEvent(calendarId = "primary", eventId, patch) {
    const res = await ufetch(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }
    );
    return res.json();
  }

  // ── Delete an event ───────────────────────────────────────────────────────

  async function deleteEvent(calendarId = "primary", eventId) {
    await ufetch(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      { method: "DELETE" }
    );
    return { ok: true, eventId };
  }

  // ── Normalize a Calendar event into a clean object ────────────────────────

  function normalizeEvent(evt) {
    const attendees = (evt.attendees || []).map((a) => ({
      email: a.email,
      name: a.displayName || "",
      status: a.responseStatus || "needsAction",
      self: !!a.self,
      organizer: !!a.organizer,
    }));

    return {
      eventId: evt.id,
      title: evt.summary || "",
      description: evt.description || "",
      location: evt.location || "",
      startTime: evt.start?.dateTime || evt.start?.date || "",
      endTime: evt.end?.dateTime || evt.end?.date || "",
      allDay: !!evt.start?.date && !evt.start?.dateTime,
      organizer: evt.organizer?.email || "",
      attendees,
      status: evt.status || "",
      htmlLink: evt.htmlLink || "",
      hangoutLink: evt.hangoutLink || evt.conferenceData?.entryPoints?.[0]?.uri || "",
      recurrence: evt.recurrence || [],
      rawJson: JSON.stringify({
        id: evt.id,
        conferenceData: evt.conferenceData,
        extendedProperties: evt.extendedProperties,
      }),
    };
  }

  // ── Fetch today's events (normalized) ────────────────────────────────────

  async function fetchTodayEvents(calendarId = "primary") {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const events = await listEvents(calendarId, { timeMin: startOfDay, timeMax: endOfDay });
    return events.map(normalizeEvent);
  }

  // ── Fetch events in a date range (normalized) ─────────────────────────────

  async function fetchEventsInRange(calendarId = "primary", { from, to } = {}) {
    const events = await listEvents(calendarId, {
      timeMin: from || new Date().toISOString(),
      timeMax: to || new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    return events.map(normalizeEvent);
  }

  // ── Create a simple event helper ──────────────────────────────────────────

  async function createSimpleEvent(calendarId = "primary", {
    title,
    startTime,
    endTime,
    description = "",
    attendeeEmails = [],
    location = "",
    origin = "",
  } = {}) {
    const event = {
      summary: title,
      description,
      location,
      start: { dateTime: startTime },
      end: { dateTime: endTime },
      attendees: attendeeEmails.map((email) => ({ email })),
    };
    if (origin) {
      event.extendedProperties = { private: { origin } };
    }
    return createEvent(calendarId, event);
  }

  return {
    listCalendars,
    listEvents,
    getEvent,
    createEvent,
    updateEvent,
    patchEvent,
    deleteEvent,
    normalizeEvent,
    fetchTodayEvents,
    fetchEventsInRange,
    createSimpleEvent,
  };
}
