/**
 * Skill: listing-consistency-audit
 *
 * Diffs price, terms, photos, descriptions, and titles across
 * Airbnb/VRBO/Booking.com and returns a structured divergence report.
 *
 * Status: stub — real implementation pulls snapshots from `listing_snapshot`
 * and runs the diff engine. Filled in during the next sprint.
 */
import type { Env } from '../../worker-configuration';

export interface AuditReportEntry {
  listingNodeId: string;
  field: 'price' | 'min_nights' | 'title' | 'description' | 'photo_urls';
  platformValues: Record<string, unknown>;
}

export interface AuditReport {
  runAt: string;
  divergenceCount: number;
  entries: AuditReportEntry[];
}

export async function listingConsistencyAudit(
  _env: Env,
  _opts: { propertyId?: string } = {},
): Promise<AuditReport> {
  return {
    runAt: new Date().toISOString(),
    divergenceCount: 0,
    entries: [],
  };
}
