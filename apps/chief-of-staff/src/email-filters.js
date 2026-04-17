/**
 * email-filters.js — Email filtering and monitoring for the chief-of-staff agent.
 *
 * Allows defining patterns to watch for specific emails (by sender or body content).
 * Matching emails are flagged and surfaced in the planning context.
 *
 * Factory: createEmailFilterTools({ sheets }) returns the email filter MCP tools.
 */

function nowIso() { return new Date().toISOString(); }

function generateId(prefix = "filter") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeParseArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// ── Email matching logic ─────────────────────────────────────────────────────

function matchesFilter(email, filter) {
  const senderPattern = filter.senderPattern || "";
  const bodyKeywords = safeParseArray(filter.bodyKeywordsJson || "[]");

  let senderMatch = true;
  if (senderPattern) {
    senderMatch = (email.from || "").toLowerCase().includes(senderPattern.toLowerCase());
  }

  let bodyMatch = true;
  if (bodyKeywords.length > 0) {
    const bodyLower = (email.body || "").toLowerCase();
    bodyMatch = bodyKeywords.some(kw => bodyLower.includes(kw.toLowerCase()));
  }

  return senderMatch && bodyMatch;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createEmailFilterTools({ sheets }) {
  // ── Create filter ────────────────────────────────────────────────────────

  async function createFilter({
    name = "",
    description = "",
    senderPattern = "",
    bodyKeywords = [],
    priority = "medium",
  } = {}) {
    if (!name || (!senderPattern && bodyKeywords.length === 0)) {
      throw new Error("Filter requires a name and at least a sender pattern or body keywords");
    }

    const filterId = generateId("filter");
    const row = [
      filterId,
      name,
      description,
      senderPattern,
      JSON.stringify(bodyKeywords),
      priority,
      "1", // enabled
      nowIso(),
      "",
    ];

    await sheets.appendRows("EmailFilters", [row]);
    return { filterId, name, description, senderPattern, bodyKeywords, priority };
  }

  // ── List filters ────────────────────────────────────────────────────────

  async function listFilters({ enabled = null } = {}) {
    const rows = await sheets.readSheetAsObjects("EmailFilters");
    let filters = rows.map((r) => ({
      filterId: r.filterId,
      name: r.name,
      description: r.description,
      senderPattern: r.senderPattern,
      bodyKeywords: safeParseArray(r.bodyKeywordsJson),
      priority: r.priority,
      enabled: r.enabled !== "0",
      createdAt: r.createdAt,
    }));

    if (enabled !== null) {
      filters = filters.filter(f => f.enabled === enabled);
    }

    return filters;
  }

  // ── Delete filter ────────────────────────────────────────────────────────

  async function deleteFilter(filterId) {
    const found = await sheets.findRowByKey("EmailFilters", "filterId", filterId);
    if (!found) {
      throw new Error(`Filter ${filterId} not found`);
    }
    await sheets.deleteRow("EmailFilters", found.rowNum);
    return { deleted: true };
  }

  // ── Update filter ────────────────────────────────────────────────────────

  async function updateFilter(filterId, updates = {}) {
    const found = await sheets.findRowByKey("EmailFilters", "filterId", filterId);
    if (!found) {
      throw new Error(`Filter ${filterId} not found`);
    }

    const existing = await sheets.readSheetAsObjects("EmailFilters");
    const current = existing.find(r => r.filterId === filterId);
    if (!current) {
      throw new Error(`Filter ${filterId} not found`);
    }

    const row = [
      current.filterId,
      updates.name !== undefined ? updates.name : current.name,
      updates.description !== undefined ? updates.description : current.description,
      updates.senderPattern !== undefined ? updates.senderPattern : current.senderPattern,
      updates.bodyKeywords !== undefined ? JSON.stringify(updates.bodyKeywords) : current.bodyKeywordsJson,
      updates.priority !== undefined ? updates.priority : current.priority,
      updates.enabled !== undefined ? (updates.enabled ? "1" : "0") : current.enabled,
      current.createdAt,
      nowIso(),
    ];

    await sheets.updateRow("EmailFilters", found.rowNum, row);
    return { updated: true };
  }

  // ── Flag email (called during ingest) ────────────────────────────────────

  async function flagEmail(email, matchedFilters = []) {
    if (matchedFilters.length === 0) return null;

    const flagId = generateId("flag");
    const priority = matchedFilters.reduce((max, f) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return Math.max(max, priorityOrder[f.priority] || 1);
    }, 1);

    const priorityMap = { 3: "high", 2: "medium", 1: "low" };
    const filterIds = matchedFilters.map(f => f.filterId).join(",");

    const row = [
      flagId,
      filterIds,
      email.messageId || "",
      email.threadId || "",
      email.subject || "",
      email.from || "",
      email.date || "",
      email.snippet || "",
      priorityMap[priority],
      "new",
      "",
      "",
      "",
      nowIso(),
    ];

    await sheets.appendRows("FlaggedEmails", [row]);
    return { flagId, messageId: email.messageId, filterId: filterIds };
  }

  // ── Get flagged emails (for planning context) ────────────────────────────

  async function getFlaggedEmails({ status = "new", limit = 10 } = {}) {
    const rows = await sheets.readSheetAsObjects("FlaggedEmails");
    let emails = rows.map((r) => ({
      flagId: r.flagId,
      messageId: r.messageId,
      threadId: r.threadId,
      subject: r.subject,
      from: r.from_addr,
      date: r.date,
      snippet: r.snippet,
      filterIds: (r.filterId || "").split(","),
      priority: r.priority,
      status: r.status,
      flaggedAt: r.flaggedAt,
    }));

    if (status) {
      emails = emails.filter(e => e.status === status);
    }

    return emails
      .sort((a, b) => new Date(b.flaggedAt) - new Date(a.flaggedAt))
      .slice(0, limit);
  }

  // ── Update flagged email status ──────────────────────────────────────────

  async function updateFlaggedEmailStatus(flagId, newStatus, actionNotes = "") {
    const found = await sheets.findRowByKey("FlaggedEmails", "flagId", flagId);
    if (!found) {
      throw new Error(`Flagged email ${flagId} not found`);
    }

    const existing = await sheets.readSheetAsObjects("FlaggedEmails");
    const current = existing.find(r => r.flagId === flagId);
    if (!current) {
      throw new Error(`Flagged email ${flagId} not found`);
    }

    const actionedAt = newStatus === "actioned" ? nowIso() : current.actionedAt;
    const row = [
      current.flagId,
      current.filterId,
      current.messageId,
      current.threadId,
      current.subject,
      current.from_addr,
      current.date,
      current.snippet,
      current.priority,
      newStatus,
      current.surfacedAt,
      actionedAt,
      actionNotes,
      current.flaggedAt,
    ];

    await sheets.updateRow("FlaggedEmails", found.rowNum, row);
    return { updated: true, flagId, status: newStatus };
  }

  // ── Scan emails and flag matches ─────────────────────────────────────────

  async function scanEmailsForFilters(emails) {
    const filters = await listFilters({ enabled: true });
    const flagged = [];

    for (const email of emails) {
      const matches = filters.filter(f => matchesFilter(email, f));
      if (matches.length > 0) {
        const flag = await flagEmail(email, matches);
        if (flag) flagged.push(flag);
      }
    }

    return flagged;
  }

  return {
    createFilter,
    listFilters,
    deleteFilter,
    updateFilter,
    flagEmail,
    getFlaggedEmails,
    updateFlaggedEmailStatus,
    scanEmailsForFilters,
  };
}

export function createEmailFilterMCPTools({ sheets }) {
  const {
    createFilter,
    listFilters,
    deleteFilter,
    updateFilter,
    getFlaggedEmails,
    updateFlaggedEmailStatus,
  } = createEmailFilterTools({ sheets });

  return [
    {
      name: "create_email_filter",
      description: "Create a new email filter to watch for specific senders or keywords",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name for this filter (e.g., 'Teaching Schedule Form')",
          },
          description: {
            type: "string",
            description: "What this filter is for",
          },
          senderPattern: {
            type: "string",
            description: "Email substring to match in the From field (case-insensitive, optional)",
          },
          bodyKeywords: {
            type: "array",
            items: { type: "string" },
            description: "Keywords to search for in email body (case-insensitive, optional)",
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Priority level for matched emails (default: medium)",
          },
        },
        required: ["name"],
      },
      handler: async (input) => {
        return await createFilter(input);
      },
    },
    {
      name: "list_email_filters",
      description: "List all email filters",
      inputSchema: {
        type: "object",
        properties: {
          enabledOnly: {
            type: "boolean",
            description: "If true, only show enabled filters",
          },
        },
      },
      handler: async (input) => {
        return await listFilters({ enabled: input.enabledOnly ? true : null });
      },
    },
    {
      name: "delete_email_filter",
      description: "Delete an email filter",
      inputSchema: {
        type: "object",
        properties: {
          filterId: {
            type: "string",
            description: "The ID of the filter to delete",
          },
        },
        required: ["filterId"],
      },
      handler: async (input) => {
        return await deleteFilter(input.filterId);
      },
    },
    {
      name: "update_email_filter",
      description: "Update an existing email filter",
      inputSchema: {
        type: "object",
        properties: {
          filterId: {
            type: "string",
            description: "The ID of the filter to update",
          },
          name: { type: "string" },
          description: { type: "string" },
          senderPattern: { type: "string" },
          bodyKeywords: {
            type: "array",
            items: { type: "string" },
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          enabled: { type: "boolean" },
        },
        required: ["filterId"],
      },
      handler: async (input) => {
        const { filterId, ...updates } = input;
        return await updateFilter(filterId, updates);
      },
    },
    {
      name: "get_flagged_emails",
      description: "Get emails that matched filter rules (for immediate response)",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["new", "reviewed", "actioned", "dismissed"],
            description: "Filter by status (default: new)",
          },
          limit: {
            type: "integer",
            description: "Max results (default: 10)",
          },
        },
      },
      handler: async (input) => {
        return await getFlaggedEmails({
          status: input.status || "new",
          limit: input.limit || 10,
        });
      },
    },
    {
      name: "mark_flagged_email",
      description: "Mark a flagged email as reviewed, actioned, or dismissed",
      inputSchema: {
        type: "object",
        properties: {
          flagId: {
            type: "string",
            description: "The flag ID of the email",
          },
          status: {
            type: "string",
            enum: ["reviewed", "actioned", "dismissed"],
            description: "New status for the email",
          },
          actionNotes: {
            type: "string",
            description: "Optional notes about what action was taken",
          },
        },
        required: ["flagId", "status"],
      },
      handler: async (input) => {
        return await updateFlaggedEmailStatus(input.flagId, input.status, input.actionNotes);
      },
    },
  ];
}
