export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  APP_NAME: string;
  ADMIN_TOKEN?: string;
  PUBLIC_BASE_URL?: string;   // e.g. https://book.example.com
  DEFAULT_CURRENCY?: string;  // fallback currency, default "USD"

  // Stripe
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;

  // Square
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_LOCATION_ID?: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  SQUARE_ENV?: string;        // 'sandbox' | 'production'
}

export interface Property {
  id: number;
  name: string;
  address: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  description: string | null;
  created_at: string;
}

export interface Review {
  id: number;
  property_id: number;
  booking_id: number | null;
  author_name: string;
  rating: number;             // 1..5
  title: string | null;
  body: string | null;
  source: string;             // direct|airbnb|vrbo|booking|google|manual
  external_id: string | null;
  published: number;          // 0 | 1
  stay_date: string | null;
  created_at: string;
}

export type UnitKind = "atomic" | "composite";

export interface Unit {
  id: number;
  property_id: number;
  name: string;
  kind: UnitKind;
  sleeps: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  base_price: number | null;
  cleaning_fee: number | null;
  min_nights: number | null;
  description: string | null;
  amenities_json: string | null;
  house_rules: string | null;
  created_at: string;
}

export interface Platform {
  id: number;
  slug: string;
  display_name: string;
  adapter: string;
  api_credentials: string | null;
}

export interface Listing {
  id: number;
  unit_id: number;
  platform_id: number;
  external_id: string | null;
  title: string | null;
  status: string;
  ical_import_url: string | null;
  export_token: string;
  last_pulled_at: string | null;
  last_error: string | null;
  overrides_json: string | null;
  created_at: string;
}

export interface Booking {
  id: number;
  unit_id: number;
  listing_id: number | null;
  source_platform: string;
  external_uid: string | null;
  status: string;
  start_date: string; // YYYY-MM-DD
  end_date: string;   // YYYY-MM-DD (checkout, exclusive)
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  adults: number | null;
  children: number | null;
  total_amount: number | null;
  currency: string | null;
  notes: string | null;
  raw_json: string | null;
  hold_expires_at: string | null;
  payment_provider: string | null;
  payment_session_id: string | null;
  payment_intent_id: string | null;
  payment_status: string | null;
  amount_cents: number | null;
  nights: number | null;
  created_at: string;
  updated_at: string;
}

export interface Photo {
  id: number;
  unit_id: number;
  r2_key: string;
  caption: string | null;
  sort_order: number;
  width: number | null;
  height: number | null;
  content_type: string | null;
  size_bytes: number | null;
  created_at: string;
}
