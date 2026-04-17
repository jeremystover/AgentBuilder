/**
 * Chief-of-Staff GAS bridge.
 *
 * A Google Apps Script web app that exposes the deployer's Gmail + Calendar
 * over HTTP so the chief-of-staff MCP (running on Cloudflare Workers) can
 * reach a work Google account without an OAuth client.
 *
 * Deploy:
 *   1. New Apps Script project in the target Google account.
 *   2. Paste this file as Code.gs and copy appsscript.json into the manifest.
 *      (Project Settings → "Show appsscript.json manifest file in editor".)
 *   3. Project Settings → Script properties → add API_KEY = <a long random string>.
 *   4. Deploy → New deployment → Web app.
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copy the /exec URL.
 *   5. On the MCP side, store the URL + API_KEY as secrets (e.g.
 *      GAS_BRIDGE_URL, GAS_BRIDGE_KEY) and POST {action, params} to it.
 *
 * Request shape (POST):
 *   { "action": "listEvents", "params": { ... }, "apiKey": "..." }
 *   — apiKey may also be sent as X-API-Key header or ?key= query param.
 *
 * Response shape:
 *   { "ok": true,  "result": ... }
 *   { "ok": false, "error": "...", "action": "..." }
 */

// ─── Entry points ──────────────────────────────────────────────────────────

function doGet(e) {
  // Health check only — actions must use POST.
  if (!authorize_(e)) return jsonOut_({ ok: false, error: "unauthorized" }, 401);
  return jsonOut_({
    ok: true,
    result: {
      service: "chief-of-staff-gas-bridge",
      email: Session.getActiveUser().getEmail() || "",
      timeZone: Session.getScriptTimeZone(),
      now: new Date().toISOString(),
    },
  });
}

function doPost(e) {
  if (!authorize_(e)) return jsonOut_({ ok: false, error: "unauthorized" }, 401);

  var body = {};
  try {
    body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
  } catch (err) {
    return jsonOut_({ ok: false, error: "invalid JSON body" }, 400);
  }

  var action = body.action || (e && e.parameter && e.parameter.action) || "";
  var params = body.params || {};

  var handler = HANDLERS[action];
  if (!handler) {
    return jsonOut_({ ok: false, error: "unknown action: " + action, action: action }, 400);
  }

  try {
    var result = handler(params);
    return jsonOut_({ ok: true, result: result });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err), action: action }, 500);
  }
}

// ─── Auth + response helpers ───────────────────────────────────────────────

function authorize_(e) {
  var expected = PropertiesService.getScriptProperties().getProperty("API_KEY");
  if (!expected) return false; // fail closed if not configured

  var provided = "";
  if (e && e.parameter && e.parameter.key) provided = e.parameter.key;
  if (!provided && e && e.postData && e.postData.contents) {
    try {
      var b = JSON.parse(e.postData.contents);
      if (b && b.apiKey) provided = b.apiKey;
    } catch (_) { /* ignore */ }
  }
  // Header is not directly exposed in GAS; clients should send apiKey in body or key= query.
  return provided && provided === expected;
}

function jsonOut_(obj, _status) {
  // Note: GAS web apps can't set arbitrary HTTP status codes. The status arg
  // is advisory — callers should rely on {ok, error} in the JSON payload.
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Action router ─────────────────────────────────────────────────────────

var HANDLERS = {
  ping:            function () { return { pong: true, now: new Date().toISOString() }; },
  whoami:          handleWhoami_,

  // Calendar
  listCalendars:   handleListCalendars_,
  listEvents:      handleListEvents_,
  todayEvents:     handleTodayEvents_,
  upcomingEvents:  handleUpcomingEvents_,
  createEvent:     handleCreateEvent_,
  updateEvent:     handleUpdateEvent_,
  deleteEvent:     handleDeleteEvent_,

  // Gmail
  searchThreads:   handleSearchThreads_,
  getThread:       handleGetThread_,
  recentEmails:    handleRecentEmails_,
  createDraft:     handleCreateDraft_,
  sendEmail:       handleSendEmail_,
  addLabel:        handleAddLabel_,
  removeLabel:     handleRemoveLabel_,
  listLabels:      handleListLabels_,
};

// ─── Whoami ────────────────────────────────────────────────────────────────

function handleWhoami_() {
  return {
    email: Session.getActiveUser().getEmail() || "",
    effectiveEmail: Session.getEffectiveUser().getEmail() || "",
    timeZone: Session.getScriptTimeZone(),
  };
}

// ─── Calendar handlers ─────────────────────────────────────────────────────

function handleListCalendars_() {
  return CalendarApp.getAllCalendars().map(function (c) {
    return {
      id: c.getId(),
      name: c.getName(),
      description: c.getDescription() || "",
      color: c.getColor(),
      timeZone: c.getTimeZone(),
      isOwned: c.isOwnedByMe(),
      isPrimary: c.isMyPrimaryCalendar(),
    };
  });
}

function handleListEvents_(params) {
  var calendarId = params.calendarId || "primary";
  var from = params.from ? new Date(params.from) : new Date();
  var to = params.to
    ? new Date(params.to)
    : new Date(from.getTime() + 7 * 24 * 3600 * 1000);

  var cal = calendarId === "primary"
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error("calendar not found: " + calendarId);

  var events = cal.getEvents(from, to);
  return events.map(normalizeEvent_);
}

function handleTodayEvents_(params) {
  var cal = params && params.calendarId
    ? CalendarApp.getCalendarById(params.calendarId)
    : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error("calendar not found");
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return cal.getEvents(start, end).map(normalizeEvent_);
}

function handleUpcomingEvents_(params) {
  var days = Math.max(1, Math.min(30, Number(params && params.days) || 7));
  var cal = params && params.calendarId
    ? CalendarApp.getCalendarById(params.calendarId)
    : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error("calendar not found");
  var start = new Date();
  var end = new Date(start.getTime() + days * 24 * 3600 * 1000);
  return cal.getEvents(start, end).map(normalizeEvent_);
}

function handleCreateEvent_(params) {
  if (!params || !params.title || !params.startTime || !params.endTime) {
    throw new Error("createEvent requires title, startTime, endTime");
  }
  var cal = params.calendarId
    ? CalendarApp.getCalendarById(params.calendarId)
    : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error("calendar not found");

  var options = {};
  if (params.description) options.description = params.description;
  if (params.location) options.location = params.location;
  if (params.attendees && params.attendees.length) {
    options.guests = params.attendees.join(",");
    options.sendInvites = params.sendInvites !== false;
  }

  var event = cal.createEvent(
    params.title,
    new Date(params.startTime),
    new Date(params.endTime),
    options
  );
  return normalizeEvent_(event);
}

function handleUpdateEvent_(params) {
  if (!params || !params.eventId) throw new Error("updateEvent requires eventId");
  var cal = params.calendarId
    ? CalendarApp.getCalendarById(params.calendarId)
    : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error("calendar not found");

  var event = cal.getEventById(params.eventId);
  if (!event) throw new Error("event not found: " + params.eventId);

  if (params.title) event.setTitle(params.title);
  if (params.description !== undefined) event.setDescription(params.description);
  if (params.location !== undefined) event.setLocation(params.location);
  if (params.startTime && params.endTime) {
    event.setTime(new Date(params.startTime), new Date(params.endTime));
  }
  if (params.addGuests) {
    params.addGuests.forEach(function (g) { event.addGuest(g); });
  }
  if (params.removeGuests) {
    params.removeGuests.forEach(function (g) { event.removeGuest(g); });
  }
  return normalizeEvent_(event);
}

function handleDeleteEvent_(params) {
  if (!params || !params.eventId) throw new Error("deleteEvent requires eventId");
  var cal = params.calendarId
    ? CalendarApp.getCalendarById(params.calendarId)
    : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error("calendar not found");
  var event = cal.getEventById(params.eventId);
  if (!event) throw new Error("event not found: " + params.eventId);
  event.deleteEvent();
  return { deleted: true, eventId: params.eventId };
}

function normalizeEvent_(evt) {
  var guests = evt.getGuestList().map(function (g) {
    return {
      email: g.getEmail(),
      name: g.getName() || "",
      status: String(g.getGuestStatus()),
    };
  });
  return {
    eventId: evt.getId(),
    title: evt.getTitle() || "",
    description: evt.getDescription() || "",
    location: evt.getLocation() || "",
    startTime: evt.getStartTime().toISOString(),
    endTime: evt.getEndTime().toISOString(),
    allDay: evt.isAllDayEvent(),
    creator: evt.getCreators()[0] || "",
    guests: guests,
    isRecurring: evt.isRecurringEvent ? evt.isRecurringEvent() : false,
    visibility: String(evt.getVisibility()),
  };
}

// ─── Gmail handlers ────────────────────────────────────────────────────────

function handleSearchThreads_(params) {
  var query = (params && params.query) || "";
  var max = Math.max(1, Math.min(100, Number(params && params.max) || 25));
  var threads = GmailApp.search(query, 0, max);
  return threads.map(summarizeThread_);
}

function handleRecentEmails_(params) {
  // Convenience wrapper over search for "last N hours of new mail".
  var hours = Math.max(1, Math.min(168, Number(params && params.hours) || 24));
  var max = Math.max(1, Math.min(100, Number(params && params.max) || 25));
  var extra = (params && params.query) ? (" " + params.query) : "";
  var afterEpoch = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  var q = ("after:" + afterEpoch + extra).trim();
  var threads = GmailApp.search(q, 0, max);
  return threads.map(summarizeThread_);
}

function handleGetThread_(params) {
  if (!params || !params.threadId) throw new Error("getThread requires threadId");
  var thread = GmailApp.getThreadById(params.threadId);
  if (!thread) throw new Error("thread not found: " + params.threadId);
  return {
    threadId: thread.getId(),
    subject: thread.getFirstMessageSubject(),
    messageCount: thread.getMessageCount(),
    lastMessageDate: thread.getLastMessageDate().toISOString(),
    permalink: thread.getPermalink(),
    labels: thread.getLabels().map(function (l) { return l.getName(); }),
    messages: thread.getMessages().map(normalizeMessage_),
  };
}

function handleCreateDraft_(params) {
  if (!params || !params.to || !params.subject) {
    throw new Error("createDraft requires to and subject");
  }
  var options = {};
  if (params.cc) options.cc = params.cc;
  if (params.bcc) options.bcc = params.bcc;
  if (params.htmlBody) options.htmlBody = params.htmlBody;

  var draft;
  if (params.threadId) {
    // Reply-in-thread draft: find the latest message and use createDraftReply.
    var thread = GmailApp.getThreadById(params.threadId);
    if (!thread) throw new Error("thread not found: " + params.threadId);
    var msgs = thread.getMessages();
    var last = msgs[msgs.length - 1];
    draft = last.createDraftReply(params.body || "", Object.assign({ subject: params.subject }, options));
  } else {
    draft = GmailApp.createDraft(params.to, params.subject, params.body || "", options);
  }
  return {
    draftId: draft.getId(),
    messageId: draft.getMessage().getId(),
    threadId: draft.getMessage().getThread().getId(),
  };
}

function handleSendEmail_(params) {
  if (!params || !params.to || !params.subject) {
    throw new Error("sendEmail requires to and subject");
  }
  var options = {};
  if (params.cc) options.cc = params.cc;
  if (params.bcc) options.bcc = params.bcc;
  if (params.htmlBody) options.htmlBody = params.htmlBody;
  GmailApp.sendEmail(params.to, params.subject, params.body || "", options);
  return { sent: true };
}

function handleAddLabel_(params) {
  if (!params || !params.threadId || !params.label) {
    throw new Error("addLabel requires threadId and label");
  }
  var thread = GmailApp.getThreadById(params.threadId);
  if (!thread) throw new Error("thread not found: " + params.threadId);
  var label = GmailApp.getUserLabelByName(params.label) || GmailApp.createLabel(params.label);
  thread.addLabel(label);
  return { added: true, label: params.label };
}

function handleRemoveLabel_(params) {
  if (!params || !params.threadId || !params.label) {
    throw new Error("removeLabel requires threadId and label");
  }
  var thread = GmailApp.getThreadById(params.threadId);
  if (!thread) throw new Error("thread not found: " + params.threadId);
  var label = GmailApp.getUserLabelByName(params.label);
  if (!label) return { removed: false, reason: "label not found" };
  thread.removeLabel(label);
  return { removed: true, label: params.label };
}

function handleListLabels_() {
  return GmailApp.getUserLabels().map(function (l) {
    return { name: l.getName() };
  });
}

function summarizeThread_(thread) {
  return {
    threadId: thread.getId(),
    subject: thread.getFirstMessageSubject(),
    from: thread.getMessages()[0].getFrom(),
    messageCount: thread.getMessageCount(),
    lastMessageDate: thread.getLastMessageDate().toISOString(),
    snippet: (thread.getMessages()[thread.getMessageCount() - 1].getPlainBody() || "").slice(0, 300),
    labels: thread.getLabels().map(function (l) { return l.getName(); }),
    isUnread: thread.isUnread(),
    isImportant: thread.isImportant(),
    permalink: thread.getPermalink(),
  };
}

function normalizeMessage_(msg) {
  return {
    messageId: msg.getId(),
    threadId: msg.getThread().getId(),
    subject: msg.getSubject(),
    from: msg.getFrom(),
    to: msg.getTo(),
    cc: msg.getCc(),
    date: msg.getDate().toISOString(),
    body: msg.getPlainBody() || "",
    isUnread: msg.isUnread(),
    isStarred: msg.isStarred(),
  };
}
