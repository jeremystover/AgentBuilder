/**
 * Skill: inventory-graph-management
 *
 * CRUD for `listing_node` and `listing_edge` rows. The graph is generic:
 * no farm-house topology is hardcoded here. Adding a second property or
 * reconfiguring listings is a data operation, not a code change.
 *
 * Edge semantics:
 *   - `contains`        booking the *to* node blocks the *from* node
 *                       (e.g. "4BR-whole-house" contains "room-1")
 *   - `conflicts_with`  symmetric — booking either blocks the other
 *                       (e.g. "4BR" and "3BR-with-host" over the same rooms)
 */
import type { Env } from '../../worker-configuration';

export interface ListingNode {
  id: string;
  guestyId?: string;
  platform: 'airbnb' | 'vrbo' | 'booking_com' | 'guesty';
  externalListingId: string;
  displayName: string;
  propertyId?: string;
}

export interface ListingEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: 'contains' | 'conflicts_with';
}

export async function upsertListingNode(env: Env, node: ListingNode): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO listing_node (id, guesty_id, platform, external_listing_id, display_name, property_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       guesty_id = excluded.guesty_id,
       platform = excluded.platform,
       external_listing_id = excluded.external_listing_id,
       display_name = excluded.display_name,
       property_id = COALESCE(excluded.property_id, listing_node.property_id)`,
  )
    .bind(
      node.id,
      node.guestyId ?? null,
      node.platform,
      node.externalListingId,
      node.displayName,
      node.propertyId ?? null,
    )
    .run();
}

export async function upsertEdge(env: Env, edge: ListingEdge): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO listing_edge (id, from_node_id, to_node_id, edge_type)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       from_node_id = excluded.from_node_id,
       to_node_id = excluded.to_node_id,
       edge_type = excluded.edge_type`,
  )
    .bind(edge.id, edge.fromNodeId, edge.toNodeId, edge.edgeType)
    .run();
}
