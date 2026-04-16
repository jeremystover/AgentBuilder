/**
 * Skill: listing-import
 *
 * Imports listings from Guesty (via API) or Airbnb/VRBO (manual entry).
 * After import, returns existing listings from other platforms so the
 * caller (Claude) can ask the user which listings represent the same
 * physical property and should be linked together.
 *
 * Also provides `linkListings` to assign the same property_id to
 * listings that represent the same property across platforms.
 */
import type { Env } from '../../worker-configuration';
import { guestyRequest } from './platform-api-integration.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type Platform = 'guesty' | 'airbnb' | 'vrbo';

export interface ManualListingInput {
  externalId: string;
  name: string;
  title?: string;
  description?: string;
  priceCents?: number;
  cleaningFeeCents?: number;
  securityDepositCents?: number;
  weeklyDiscountPct?: number;
  monthlyDiscountPct?: number;
  minNights?: number;
  maxNights?: number;
  instantBook?: boolean;
  cancellationPolicy?: string;
  maxGuests?: number;
  bedrooms?: number;
  bathrooms?: number;
  beds?: number;
  checkInTime?: string;
  checkOutTime?: string;
  photoUrls?: string[];
  amenities?: string[];
  houseRules?: string;
  petPolicy?: string;
  propertyType?: string;
}

export interface ImportListingsInput {
  platform: Platform;
  /** For manual import (Airbnb/VRBO). Omit to fetch from API (Guesty). */
  listings?: ManualListingInput[];
}

export interface ImportedListing {
  nodeId: string;
  platform: Platform;
  externalId: string;
  displayName: string;
}

export interface ImportListingsResult {
  imported: ImportedListing[];
  /** Existing listings from OTHER platforms, surfaced so the user can link them. */
  existingFromOtherPlatforms: Array<{
    nodeId: string;
    platform: string;
    externalId: string;
    displayName: string;
    propertyId: string | null;
  }>;
  message: string;
}

export interface LinkListingsInput {
  /** Array of listing node IDs that represent the same physical property. */
  listingNodeIds: string[];
  /** Optional display label for the property group. */
  propertyLabel?: string;
}

export interface LinkListingsResult {
  propertyId: string;
  linkedCount: number;
  listings: Array<{
    nodeId: string;
    platform: string;
    displayName: string;
  }>;
}

// ── Guesty API fetch ─────────────────────────────────────────────────────────

interface GuestyListing {
  _id: string;
  title?: string;
  nickname?: string;
  address?: { full?: string };
  bedrooms?: number;
  bathrooms?: number;
  beds?: number;
  accommodates?: number;
  prices?: {
    basePrice?: number;
    cleaningFee?: number;
    securityDeposit?: number;
    weeklyPriceFactor?: number;
    monthlyPriceFactor?: number;
  };
  terms?: {
    minNights?: number;
    maxNights?: number;
    cancellation?: string;
  };
  publicDescription?: {
    summary?: string;
    space?: string;
    access?: string;
    notes?: string;
  };
  pictures?: Array<{ original?: string; thumbnail?: string; caption?: string }>;
  instantBooking?: { enabled?: boolean };
  amenities?: string[];
  houseRules?: string;
  propertyType?: string;
  checkInTime?: string;
  checkOutTime?: string;
}

async function fetchGuestyListings(env: Env): Promise<ManualListingInput[]> {
  const resp = await guestyRequest(
    env,
    '/v1/listings?limit=100&fields=title,nickname,address,bedrooms,bathrooms,beds,accommodates,prices,terms,publicDescription,pictures,instantBooking,amenities,houseRules,propertyType,checkInTime,checkOutTime',
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Guesty API error (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as { results: GuestyListing[] };
  return data.results.map((g) => {
    const desc = [
      g.publicDescription?.summary,
      g.publicDescription?.space,
      g.publicDescription?.access,
      g.publicDescription?.notes,
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      externalId: g._id,
      name: g.nickname || g.title || g._id,
      title: g.title,
      description: desc || undefined,
      priceCents: g.prices?.basePrice != null ? Math.round(g.prices.basePrice * 100) : undefined,
      cleaningFeeCents:
        g.prices?.cleaningFee != null ? Math.round(g.prices.cleaningFee * 100) : undefined,
      securityDepositCents:
        g.prices?.securityDeposit != null ? Math.round(g.prices.securityDeposit * 100) : undefined,
      weeklyDiscountPct:
        g.prices?.weeklyPriceFactor != null
          ? Math.round((1 - g.prices.weeklyPriceFactor) * 100)
          : undefined,
      monthlyDiscountPct:
        g.prices?.monthlyPriceFactor != null
          ? Math.round((1 - g.prices.monthlyPriceFactor) * 100)
          : undefined,
      minNights: g.terms?.minNights,
      maxNights: g.terms?.maxNights,
      instantBook: g.instantBooking?.enabled,
      cancellationPolicy: g.terms?.cancellation,
      maxGuests: g.accommodates,
      bedrooms: g.bedrooms,
      bathrooms: g.bathrooms,
      beds: g.beds,
      checkInTime: g.checkInTime,
      checkOutTime: g.checkOutTime,
      photoUrls: g.pictures?.map((p) => p.original ?? p.thumbnail ?? '').filter(Boolean),
      amenities: g.amenities,
      houseRules: g.houseRules,
      petPolicy: undefined,
      propertyType: g.propertyType,
    };
  });
}

// ── Import listings ──────────────────────────────────────────────────────────

export async function importListings(
  env: Env,
  input: ImportListingsInput,
): Promise<ImportListingsResult> {
  const { platform } = input;
  let listings = input.listings;

  // For Guesty, fetch from the API if no manual listings were supplied.
  if (platform === 'guesty' && (!listings || listings.length === 0)) {
    listings = await fetchGuestyListings(env);
  }

  if (!listings || listings.length === 0) {
    return {
      imported: [],
      existingFromOtherPlatforms: [],
      message: `No listings provided for ${platform}. For Airbnb/VRBO, supply listing data in the 'listings' array.`,
    };
  }

  const imported: ImportedListing[] = [];

  for (const listing of listings) {
    const nodeId = crypto.randomUUID();
    const guestyId = platform === 'guesty' ? listing.externalId : null;
    const displayName = listing.name || listing.title || listing.externalId;

    // Check if this listing already exists (same platform + external ID).
    const existing = await env.DB.prepare(
      'SELECT id FROM listing_node WHERE platform = ? AND external_listing_id = ?',
    )
      .bind(platform, listing.externalId)
      .first<{ id: string }>();

    const finalNodeId = existing?.id ?? nodeId;

    // Upsert the listing node.
    await env.DB.prepare(
      `INSERT INTO listing_node (id, guesty_id, platform, external_listing_id, display_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         guesty_id = excluded.guesty_id,
         platform = excluded.platform,
         external_listing_id = excluded.external_listing_id,
         display_name = excluded.display_name`,
    )
      .bind(finalNodeId, guestyId, platform, listing.externalId, displayName)
      .run();

    // Take a snapshot of the listing metadata.
    const snapshotId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO listing_snapshot (
        id, listing_node_id,
        price_cents, cleaning_fee_cents, security_deposit_cents,
        weekly_discount_pct, monthly_discount_pct,
        min_nights, max_nights, cancellation_policy, instant_book,
        title, description, photo_urls, property_type,
        bedrooms, bathrooms, beds, max_guests,
        check_in_time, check_out_time, house_rules, pet_policy, amenities
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        snapshotId,
        finalNodeId,
        listing.priceCents ?? null,
        listing.cleaningFeeCents ?? null,
        listing.securityDepositCents ?? null,
        listing.weeklyDiscountPct ?? null,
        listing.monthlyDiscountPct ?? null,
        listing.minNights ?? null,
        listing.maxNights ?? null,
        listing.cancellationPolicy ?? null,
        listing.instantBook != null ? (listing.instantBook ? 1 : 0) : null,
        listing.title ?? null,
        listing.description ?? null,
        listing.photoUrls ? JSON.stringify(listing.photoUrls) : null,
        listing.propertyType ?? null,
        listing.bedrooms ?? null,
        listing.bathrooms ?? null,
        listing.beds ?? null,
        listing.maxGuests ?? null,
        listing.checkInTime ?? null,
        listing.checkOutTime ?? null,
        listing.houseRules ?? null,
        listing.petPolicy ?? null,
        listing.amenities ? JSON.stringify(listing.amenities) : null,
      )
      .run();

    imported.push({
      nodeId: finalNodeId,
      platform,
      externalId: listing.externalId,
      displayName,
    });
  }

  // Fetch existing listings from OTHER platforms for cross-platform linking.
  const otherPlatforms = await env.DB.prepare(
    'SELECT id, platform, external_listing_id, display_name, property_id FROM listing_node WHERE platform != ?',
  )
    .bind(platform)
    .all<{
      id: string;
      platform: string;
      external_listing_id: string;
      display_name: string;
      property_id: string | null;
    }>();

  const existingFromOtherPlatforms = (otherPlatforms.results ?? []).map((row) => ({
    nodeId: row.id,
    platform: row.platform,
    externalId: row.external_listing_id,
    displayName: row.display_name,
    propertyId: row.property_id,
  }));

  const otherCount = existingFromOtherPlatforms.length;
  let message = `Imported ${imported.length} listing(s) from ${platform}.`;
  if (otherCount > 0) {
    const platforms = [...new Set(existingFromOtherPlatforms.map((l) => l.platform))];
    message += ` Found ${otherCount} existing listing(s) on ${platforms.join(', ')}. Review them to link listings that represent the same physical property using the link_listings tool.`;
  }

  return { imported, existingFromOtherPlatforms, message };
}

// ── Link listings ────────────────────────────────────────────────────────────

export async function linkListings(
  env: Env,
  input: LinkListingsInput,
): Promise<LinkListingsResult> {
  const { listingNodeIds } = input;

  if (listingNodeIds.length < 2) {
    throw new Error('At least 2 listing node IDs are required to link.');
  }

  // Check if any of these nodes already belong to a property group.
  const placeholders = listingNodeIds.map(() => '?').join(',');
  const existingNodes = await env.DB.prepare(
    `SELECT id, platform, display_name, property_id FROM listing_node WHERE id IN (${placeholders})`,
  )
    .bind(...listingNodeIds)
    .all<{ id: string; platform: string; display_name: string; property_id: string | null }>();

  if ((existingNodes.results?.length ?? 0) !== listingNodeIds.length) {
    const foundIds = new Set((existingNodes.results ?? []).map((r) => r.id));
    const missing = listingNodeIds.filter((id) => !foundIds.has(id));
    throw new Error(`Listing node(s) not found: ${missing.join(', ')}`);
  }

  // Reuse an existing property_id if any node already has one, otherwise generate new.
  const existingPropertyId = existingNodes.results?.find((n) => n.property_id)?.property_id;
  const propertyId = existingPropertyId ?? crypto.randomUUID();

  // Assign property_id to all nodes in the group.
  await env.DB.prepare(`UPDATE listing_node SET property_id = ? WHERE id IN (${placeholders})`)
    .bind(propertyId, ...listingNodeIds)
    .run();

  // Also create conflicts_with edges between all pairs so availability sync
  // knows to block across platforms.
  for (let i = 0; i < listingNodeIds.length; i++) {
    for (let j = i + 1; j < listingNodeIds.length; j++) {
      const edgeId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO listing_edge (id, from_node_id, to_node_id, edge_type)
         VALUES (?, ?, ?, 'conflicts_with')
         ON CONFLICT(id) DO NOTHING`,
      )
        .bind(edgeId, listingNodeIds[i], listingNodeIds[j])
        .run();
    }
  }

  const listings = (existingNodes.results ?? []).map((n) => ({
    nodeId: n.id,
    platform: n.platform,
    displayName: n.display_name,
  }));

  return { propertyId, linkedCount: listings.length, listings };
}
