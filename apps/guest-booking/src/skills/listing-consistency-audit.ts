/**
 * Skill: listing-consistency-audit
 *
 * Diffs listing configuration across Airbnb/VRBO/Guesty for linked
 * properties and returns a structured divergence report. The report
 * includes a field-by-field comparison table showing each platform's
 * current value so the operator can see exactly what is out of sync.
 */
import type { Env } from '../../worker-configuration';

// ── Types ────────────────────────────────────────────────────────────────────

/** All auditable fields on a listing snapshot. */
const AUDIT_FIELDS = [
  'title',
  'description',
  'price_cents',
  'cleaning_fee_cents',
  'security_deposit_cents',
  'weekly_discount_pct',
  'monthly_discount_pct',
  'min_nights',
  'max_nights',
  'cancellation_policy',
  'instant_book',
  'photo_urls',
  'property_type',
  'bedrooms',
  'bathrooms',
  'beds',
  'max_guests',
  'check_in_time',
  'check_out_time',
  'house_rules',
  'pet_policy',
  'amenities',
] as const;

type AuditField = (typeof AUDIT_FIELDS)[number];

/** Human-readable labels for display. */
const FIELD_LABELS: Record<AuditField, string> = {
  title: 'Title',
  description: 'Description',
  price_cents: 'Nightly Price',
  cleaning_fee_cents: 'Cleaning Fee',
  security_deposit_cents: 'Security Deposit',
  weekly_discount_pct: 'Weekly Discount %',
  monthly_discount_pct: 'Monthly Discount %',
  min_nights: 'Min Nights',
  max_nights: 'Max Nights',
  cancellation_policy: 'Cancellation Policy',
  instant_book: 'Instant Book',
  photo_urls: 'Photos',
  property_type: 'Property Type',
  bedrooms: 'Bedrooms',
  bathrooms: 'Bathrooms',
  beds: 'Beds',
  max_guests: 'Max Guests',
  check_in_time: 'Check-in Time',
  check_out_time: 'Check-out Time',
  house_rules: 'House Rules',
  pet_policy: 'Pet Policy',
  amenities: 'Amenities',
};

export interface FieldComparison {
  field: AuditField;
  fieldLabel: string;
  inSync: boolean;
  /** Each platform's current value for this field. */
  platformValues: Record<string, unknown>;
}

export interface PropertyAuditEntry {
  propertyId: string;
  propertyLabel: string;
  platforms: string[];
  totalFields: number;
  divergentFields: number;
  comparisons: FieldComparison[];
}

export interface AuditReport {
  runAt: string;
  propertiesAudited: number;
  totalDivergences: number;
  properties: PropertyAuditEntry[];
}

// ── Snapshot row type ────────────────────────────────────────────────────────

interface SnapshotRow {
  listing_node_id: string;
  platform: string;
  display_name: string;
  property_id: string;
  snapshot_at: string;
  title: string | null;
  description: string | null;
  price_cents: number | null;
  cleaning_fee_cents: number | null;
  security_deposit_cents: number | null;
  weekly_discount_pct: number | null;
  monthly_discount_pct: number | null;
  min_nights: number | null;
  max_nights: number | null;
  cancellation_policy: string | null;
  instant_book: number | null;
  photo_urls: string | null;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  beds: number | null;
  max_guests: number | null;
  check_in_time: string | null;
  check_out_time: string | null;
  house_rules: string | null;
  pet_policy: string | null;
  amenities: string | null;
}

// ── Comparison helpers ───────────────────────────────────────────────────────

/** Format a raw DB value for human-readable display. */
function formatValue(field: AuditField, raw: unknown): unknown {
  if (raw == null) return null;

  if (
    field === 'price_cents' ||
    field === 'cleaning_fee_cents' ||
    field === 'security_deposit_cents'
  ) {
    return `$${((raw as number) / 100).toFixed(2)}`;
  }
  if (field === 'instant_book') {
    return raw === 1 || raw === true ? 'Yes' : 'No';
  }
  if (field === 'weekly_discount_pct' || field === 'monthly_discount_pct') {
    return `${raw}%`;
  }
  if (field === 'photo_urls' || field === 'amenities') {
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(arr)) return arr;
    } catch {
      /* return raw */
    }
  }
  return raw;
}

/** Normalize a value for comparison (e.g. parse JSON arrays, trim strings). */
function normalizeForComparison(field: AuditField, raw: unknown): string {
  if (raw == null) return '__null__';

  if (field === 'photo_urls' || field === 'amenities') {
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(arr)) return JSON.stringify([...arr].sort());
    } catch {
      /* fall through */
    }
  }
  if (field === 'description' || field === 'house_rules') {
    return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  }
  return String(raw).trim().toLowerCase();
}

/** Check if all platforms have the same value for a field. */
function valuesInSync(field: AuditField, values: Record<string, unknown>): boolean {
  const normalized = Object.values(values).map((v) => normalizeForComparison(field, v));
  // Ignore nulls when only some platforms have data — still counts as out of sync.
  const nonNull = normalized.filter((v) => v !== '__null__');
  if (nonNull.length <= 1) {
    // If all are null, they're in sync. If only one has a value, that's a divergence.
    return normalized.every((v) => v === '__null__') || nonNull.length === 0;
  }
  return new Set(nonNull).size === 1 && nonNull.length === normalized.length;
}

// ── Main audit function ──────────────────────────────────────────────────────

export async function listingConsistencyAudit(
  env: Env,
  opts: { propertyId?: string } = {},
): Promise<AuditReport> {
  // Find all property groups (or a specific one).
  let propertyIds: string[];
  if (opts.propertyId) {
    propertyIds = [opts.propertyId];
  } else {
    const rows = await env.DB.prepare(
      'SELECT DISTINCT property_id FROM listing_node WHERE property_id IS NOT NULL',
    ).all<{ property_id: string }>();
    propertyIds = (rows.results ?? []).map((r) => r.property_id);
  }

  if (propertyIds.length === 0) {
    return {
      runAt: new Date().toISOString(),
      propertiesAudited: 0,
      totalDivergences: 0,
      properties: [],
    };
  }

  const properties: PropertyAuditEntry[] = [];
  let totalDivergences = 0;

  for (const propertyId of propertyIds) {
    // Get the latest snapshot for each listing in this property group.
    // Uses a correlated subquery to pick the most recent snapshot per node.
    const snapshotRows = await env.DB.prepare(
      `SELECT
         ln.id AS listing_node_id,
         ln.platform,
         ln.display_name,
         ln.property_id,
         s.snapshot_at,
         s.title, s.description,
         s.price_cents, s.cleaning_fee_cents, s.security_deposit_cents,
         s.weekly_discount_pct, s.monthly_discount_pct,
         s.min_nights, s.max_nights, s.cancellation_policy, s.instant_book,
         s.photo_urls, s.property_type,
         s.bedrooms, s.bathrooms, s.beds, s.max_guests,
         s.check_in_time, s.check_out_time,
         s.house_rules, s.pet_policy, s.amenities
       FROM listing_node ln
       INNER JOIN listing_snapshot s ON s.listing_node_id = ln.id
       WHERE ln.property_id = ?
         AND s.snapshot_at = (
           SELECT MAX(s2.snapshot_at)
           FROM listing_snapshot s2
           WHERE s2.listing_node_id = ln.id
         )
       ORDER BY ln.platform`,
    )
      .bind(propertyId)
      .all<SnapshotRow>();

    const snapshots = snapshotRows.results ?? [];
    if (snapshots.length < 2) continue; // Need at least 2 platforms to compare.

    const platforms = snapshots.map((s) => s.platform);
    const propertyLabel = snapshots.map((s) => `${s.display_name} (${s.platform})`).join(' / ');

    const comparisons: FieldComparison[] = [];
    let divergentFields = 0;

    for (const field of AUDIT_FIELDS) {
      const platformValues: Record<string, unknown> = {};
      for (const snap of snapshots) {
        const rawValue = snap[field];
        platformValues[snap.platform] = formatValue(field, rawValue);
      }

      const inSync = valuesInSync(
        field,
        Object.fromEntries(snapshots.map((snap) => [snap.platform, snap[field]])),
      );

      if (!inSync) divergentFields++;

      comparisons.push({
        field,
        fieldLabel: FIELD_LABELS[field],
        inSync,
        platformValues,
      });
    }

    totalDivergences += divergentFields;

    properties.push({
      propertyId,
      propertyLabel,
      platforms,
      totalFields: AUDIT_FIELDS.length,
      divergentFields,
      comparisons,
    });
  }

  // Persist the report for history.
  const report: AuditReport = {
    runAt: new Date().toISOString(),
    propertiesAudited: properties.length,
    totalDivergences,
    properties,
  };

  const reportId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO audit_report (id, divergence_count, report_json) VALUES (?, ?, ?)',
  )
    .bind(reportId, totalDivergences, JSON.stringify(report))
    .run();

  return report;
}
