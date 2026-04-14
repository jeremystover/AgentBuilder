/**
 * gmail.js — Gmail REST API client for Cloudflare Workers.
 *
 * Uses OAuth2 user tokens (createUserFetch) — not a service account.
 * The user must run bin/google-auth once to obtain a refresh token.
 *
 * Factory: createGmail(ufetch) returns a Gmail operations object.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export function createGmail(ufetch) {

  // ── List recent threads ───────────────────────────────────────────────────

  async function listThreads({ query = "", maxResults = 50, pageToken } = {}) {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (query) params.set("q", query);
    if (pageToken) params.set("pageToken", pageToken);
    const res = await ufetch(`${GMAIL_BASE}/threads?${params}`);
    return res.json();
  }

  // ── Get a full thread (with messages) ────────────────────────────────────

  async function getThread(threadId, { format = "metadata" } = {}) {
    const params = new URLSearchParams({ format });
    const res = await ufetch(`${GMAIL_BASE}/threads/${threadId}?${params}`);
    return res.json();
  }

  // ── Get a single message ──────────────────────────────────────────────────

  async function getMessage(messageId, { format = "full" } = {}) {
    const params = new URLSearchParams({ format });
    const res = await ufetch(`${GMAIL_BASE}/messages/${messageId}?${params}`);
    return res.json();
  }

  // ── Create a draft ────────────────────────────────────────────────────────

  async function createDraft({ to, subject, body, threadId, replyToMessageId } = {}) {
    const headers = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "MIME-Version: 1.0",
    ];
    if (replyToMessageId) headers.push(`In-Reply-To: ${replyToMessageId}`);

    const raw = btoa(unescape(encodeURIComponent(
      headers.join("\r\n") + "\r\n\r\n" + body
    ))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    const payload = { message: { raw } };
    if (threadId) payload.message.threadId = threadId;

    const res = await ufetch(`${GMAIL_BASE}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  // ── Get profile (own email address) ──────────────────────────────────────

  async function getProfile() {
    const res = await ufetch(`${GMAIL_BASE}/profile`);
    return res.json();
  }

  // ── List labels ───────────────────────────────────────────────────────────

  async function listLabels() {
    const res = await ufetch(`${GMAIL_BASE}/labels`);
    const data = await res.json();
    return data.labels || [];
  }

  // ── Modify message labels (e.g., mark read, archive) ─────────────────────

  async function modifyMessage(messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
    const res = await ufetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
    return res.json();
  }

  // ── Extract plain text from a message payload ─────────────────────────────

  function extractBody(payload) {
    if (!payload) return "";

    // Try plain text first
    if (payload.mimeType === "text/plain" && payload.body?.data) {
      return decodeBase64Url(payload.body.data);
    }

    // Recurse into parts
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          return decodeBase64Url(part.body.data);
        }
      }
      // Fallback: first part with data
      for (const part of payload.parts) {
        const body = extractBody(part);
        if (body) return body;
      }
    }

    return "";
  }

  function decodeBase64Url(data) {
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    try {
      return decodeURIComponent(escape(atob(base64)));
    } catch {
      return atob(base64);
    }
  }

  // ── Extract a named header from message headers ───────────────────────────

  function getHeader(headers, name) {
    const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
    return h?.value || "";
  }

  // ── Normalize a message into a clean object ───────────────────────────────

  function normalizeMessage(msg) {
    const headers = msg.payload?.headers || [];
    return {
      messageId: msg.id,
      threadId: msg.threadId,
      subject: getHeader(headers, "Subject"),
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      date: getHeader(headers, "Date"),
      snippet: msg.snippet || "",
      body: extractBody(msg.payload),
      labelIds: msg.labelIds || [],
      internalDate: msg.internalDate,
    };
  }

  // ── Fetch recent threads since a timestamp, normalized ────────────────────

  async function fetchRecentThreads({ since, query = "", maxResults = 30 } = {}) {
    let q = query;
    if (since) {
      const afterEpoch = Math.floor(since / 1000);
      q = `${q} after:${afterEpoch}`.trim();
    }

    const list = await listThreads({ query: q, maxResults });
    const threads = list.threads || [];

    const results = [];
    for (const { id } of threads) {
      const thread = await getThread(id, { format: "full" });
      const messages = (thread.messages || []).map(normalizeMessage);
      if (messages.length > 0) {
        results.push({
          threadId: id,
          subject: messages[0].subject,
          from: messages[0].from,
          messageCount: messages.length,
          latestDate: messages[messages.length - 1].date,
          snippet: thread.snippet || messages[messages.length - 1].snippet,
          messages,
        });
      }
    }

    return results;
  }

  return {
    listThreads,
    getThread,
    getMessage,
    createDraft,
    getProfile,
    listLabels,
    modifyMessage,
    fetchRecentThreads,
    normalizeMessage,
    extractBody,
    getHeader,
  };
}
