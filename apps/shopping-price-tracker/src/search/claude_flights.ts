/**
 * Claude API web_search adapter — daily flight price refresh.
 *
 * One completion per flight item, prompting Claude to search Google Flights
 * and major OTAs and return JSON-structured itinerary options.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env, FlightConstraints, TrackedItem } from "../types";
import { nowIso } from "../lib/time";
import type { Listing } from "./types";
import { extractFirstJsonArray } from "./_json";

const MODEL = "claude-sonnet-4-6";
// biome-ignore lint/suspicious/noExplicitAny: see claude_web.ts
const WEB_SEARCH_TOOL: any = { type: "web_search_20250305", name: "web_search", max_uses: 3 };

const MAX_RESULTS = 5;

export async function searchClaudeFlights(
  item: TrackedItem,
  flight: FlightConstraints,
  env: Env,
): Promise<Listing[]> {
  if (!env.ANTHROPIC_API_KEY) return [];

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const prompt = buildPrompt(item, flight);

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      // biome-ignore lint/suspicious/noExplicitAny: see WEB_SEARCH_TOOL above
      tools: [WEB_SEARCH_TOOL] as any,
      messages: [{ role: "user", content: prompt }],
    });
    let text = "";
    for (const block of res.content) {
      if (block.type === "text") text += block.text;
    }
    return parseListings(text);
  } catch (e) {
    console.warn("[claude_flights] error:", e);
    return [];
  }
}

interface ParsedFlight {
  airline?: string;
  flight_numbers?: string;
  depart_datetime?: string;
  return_datetime?: string;
  stops?: number;
  total_price_usd?: number;
  booking_url?: string;
}

function parseListings(text: string): Listing[] {
  const arr = extractFirstJsonArray(text);
  if (!arr) return [];
  const out: Listing[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as ParsedFlight;
    if (
      !r.booking_url ||
      typeof r.booking_url !== "string" ||
      typeof r.total_price_usd !== "number" ||
      !Number.isFinite(r.total_price_usd)
    ) {
      continue;
    }
    const titleParts: string[] = [];
    if (r.airline) titleParts.push(r.airline);
    if (r.flight_numbers) titleParts.push(r.flight_numbers);
    if (typeof r.stops === "number")
      titleParts.push(r.stops === 0 ? "nonstop" : `${r.stops} stop${r.stops === 1 ? "" : "s"}`);
    if (r.depart_datetime) titleParts.push(`out ${r.depart_datetime}`);
    if (r.return_datetime) titleParts.push(`return ${r.return_datetime}`);

    out.push({
      source: "claude_web",
      title: titleParts.join(" · ") || "flight",
      url: r.booking_url,
      priceCents: Math.round(r.total_price_usd * 100),
      currency: "USD",
      observedAt: nowIso(),
      raw: r,
    });
  }
  return out.slice(0, MAX_RESULTS);
}

function buildPrompt(item: TrackedItem, fc: FlightConstraints): string {
  const lines: string[] = [];
  const stopsClause =
    fc.nonstop || fc.max_stops === 0
      ? "nonstop only"
      : fc.max_stops != null
        ? `at most ${fc.max_stops} stop${fc.max_stops === 1 ? "" : "s"}`
        : "any stop count";
  const returnClause = fc.return_start
    ? `, returning between ${fc.return_start} and ${fc.return_end ?? fc.return_start}`
    : " (one-way)";
  lines.push(
    `Find flight options from ${fc.origin} to ${fc.destination}, departing between ${fc.depart_start} and ${fc.depart_end}${returnClause}, ${fc.cabin.replace("_", " ")} class, ${fc.pax} passenger${fc.pax === 1 ? "" : "s"}, ${stopsClause}.`,
  );
  if (item.target_price_cents)
    lines.push(`Buyer's target total price: $${(item.target_price_cents / 100).toFixed(2)}.`);
  if (item.notes) lines.push(`Buyer notes: ${item.notes}`);
  lines.push(
    "Use web_search to check Google Flights and major OTAs (Kayak, Expedia, the airline's own site).",
  );
  lines.push(
    `Return ONLY a JSON array (no prose, no markdown fence) of up to ${MAX_RESULTS} best-priced options with these exact keys:`,
  );
  lines.push(
    `[{"airline": string, "flight_numbers": string, "depart_datetime": string, "return_datetime": string | null, "stops": number, "total_price_usd": number, "booking_url": string}]`,
  );
  lines.push("If no options are found, return [].");
  return lines.join("\n");
}
