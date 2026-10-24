/**
 * Phase 1 route review catalogue.
 *
 * Every registered Express route is inventoryable from config/route-manifest.json.
 * The entries here are CANDIDATES ONLY, not authorization grants.
 * An unlisted route is unreviewed. Neither kind can authorize business writes
 * until the actual handler and side effects have been verified in Phase 3.
 */
import routeReview from "../config/access-control-v2-route-review.json";
import {
  ACCESS_CONTROL_ACTIONS,
  ACCESS_CONTROL_RESOURCES,
  type AccessControlAction,
  type AccessControlResource,
} from "./accessControlV2";

export interface AccessControlRouteCandidate {
  resource: AccessControlResource;
  action: AccessControlAction;
  status: "candidate";
}

const ACTIONS: ReadonlySet<string> = new Set(ACCESS_CONTROL_ACTIONS);
const RESOURCES: ReadonlySet<string> = new Set(ACCESS_CONTROL_RESOURCES);
const RAW_ROUTES: Record<string, { resource: string; action: string; status: string }> =
  routeReview.routes;

/**
 * Strictly matches the REGISTERED route signature (e.g. POST
 * /api/vouchers/:id/reverse), not a user URL or an arbitrary prefix. This
 * function is for review/reporting only. It must not be used as a middleware
 * grant without verified handler-level action classification.
 */
export function candidateAccessControlAction(signature: string): AccessControlRouteCandidate | null {
  if (!Object.prototype.hasOwnProperty.call(RAW_ROUTES, signature)) return null;
  const record = RAW_ROUTES[signature];
  if (
    record.status !== "candidate" ||
    !ACTIONS.has(record.action) ||
    !RESOURCES.has(record.resource)
  ) {
    return null;
  }
  return {
    resource: record.resource as AccessControlResource,
    action: record.action as AccessControlAction,
    status: "candidate",
  };
}

export function candidateAccessControlRouteCount(): number {
  return Object.keys(RAW_ROUTES).length;
}
