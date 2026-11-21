import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';

/**
 * Which surveillance events a principal may see (spec §8.5): `authority` and
 * `super_admin` see every event; any other principal only the events whose
 * vessel (`mmsi`) or related vessel (`related_mmsi`) belongs to its active
 * organization, as known from the `FLEET` projection; a principal without an
 * organization sees none. The organization never comes from the client.
 */
export type EventVisibility =
  | { readonly scope: 'all' }
  | { readonly scope: 'org'; readonly orgId: string }
  | { readonly scope: 'none' };

/** The visibility of a principal. */
export function eventVisibility(principal: Principal): EventVisibility {
  if (principal.kind === 'user' && principal.hasAuthorityAccess)
    return { scope: 'all' };
  if (principal.orgId !== null) return { scope: 'org', orgId: principal.orgId };
  return { scope: 'none' };
}

/**
 * SQL condition restricting event rows to the visibility: the vessel
 * projection decides ownership at query time, so a vessel moved to another
 * organization takes its history along.
 */
export function visibleEvents(
  visibility: EventVisibility,
  mmsi: SQLWrapper,
  relatedMmsi: SQLWrapper,
): SQL {
  switch (visibility.scope) {
    case 'all':
      return sql`TRUE`;
    case 'none':
      return sql`FALSE`;
    case 'org': {
      const owned = sql`SELECT v.mmsi FROM vessels v WHERE v.org_id = ${visibility.orgId} AND v.deleted_at IS NULL`;
      return sql`(${mmsi} IN (${owned}) OR ${relatedMmsi} IN (${owned}))`;
    }
  }
}
