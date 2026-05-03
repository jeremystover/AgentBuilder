export type { Env } from "../worker-configuration";

export type ItemKind = "product" | "flight";
export type Priority = "low" | "normal" | "high";
export type Status = "active" | "paused" | "archived";
export type Cabin = "economy" | "premium_economy" | "business" | "first";

export interface TrackedItem {
  id: string;
  kind: ItemKind;
  title: string;
  description: string;
  model_number: string;
  query_strings: string[];
  retailers: string[];
  watch_urls: string[];
  target_price_cents: number | null;
  max_price_cents: number | null;
  currency: string;
  notes: string;
  priority: Priority;
  status: Status;
  created_at: string;
  updated_at: string;
}

export interface FlightConstraints {
  item_id: string;
  origin: string;
  destination: string;
  depart_start: string;
  depart_end: string;
  return_start: string | null;
  return_end: string | null;
  nonstop: boolean;
  cabin: Cabin;
  pax: number;
  max_stops: number | null;
}

export interface PriceObservation {
  id: string;
  item_id: string;
  source: string;
  listing_title: string;
  listing_url: string;
  price_cents: number;
  shipping_cents: number | null;
  currency: string;
  in_stock: boolean | null;
  sale_flag: boolean;
  raw_json: string | null;
  observed_at: string;
}

export interface DigestRun {
  id: string;
  ran_at: string;
  item_count: number;
  email_status: "pending" | "sent" | "failed" | "skipped";
  email_error: string | null;
  summary_md: string;
  summary_html: string;
}

export interface DigestRecipient {
  email: string;
  added_at: string;
}
