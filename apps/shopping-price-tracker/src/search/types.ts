import type { FlightConstraints, TrackedItem } from "../types";

export type ListingSource =
  | "claude_web"
  | "ebay"
  | "url_watch"
  | "craigslist"
  | "amazon_paapi"
  | "amadeus";

export interface Listing {
  source: ListingSource;
  title: string;
  url: string;
  priceCents: number;
  currency: string;
  inStock?: boolean;
  saleFlag?: boolean;
  shippingCents?: number;
  observedAt: string;
  raw?: unknown;
}

export interface SearchContext {
  item: TrackedItem;
  flight?: FlightConstraints;
}
