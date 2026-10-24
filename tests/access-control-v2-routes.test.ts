import { describe, expect, it } from "vitest";
import routeManifest from "../config/route-manifest.json";
import routeReview from "../config/access-control-v2-route-review.json";
import {
  candidateAccessControlAction,
  candidateAccessControlRouteCount,
} from "../shared/accessControlV2RouteReview";
import {
  ACCESS_CONTROL_ACTIONS,
  ACCESS_CONTROL_RESOURCES,
  CREATE_ONLY_ROLE,
  evaluateAccessControl,
} from "../shared/accessControlV2";

const signatures = new Set(
  routeManifest.routes.map((row) => row.split(" [")[0])
);
const candidates = Object.entries(routeReview.routes);

describe("Phase 1 permissions V2 route coverage (shadow-mode only)", () => {
  it("inventories all current registered Express routes without inventing paths", () => {
    expect(routeManifest.routes).toHaveLength(routeManifest.routeCount);
    expect(routeManifest.middlewareMounts).toHaveLength(routeManifest.middlewareMountCount);
    expect(candidates.length).toBeGreaterThanOrEqual(100);
    expect(candidateAccessControlRouteCount()).toBe(candidates.length);
    for (const [signature] of candidates) {
      expect(signatures.has(signature), `Stale route mapping: ${signature}`).toBe(true);
    }
  });

  it("uses valid typed resources and actions for every candidate", () => {
    const resources = new Set<string>(ACCESS_CONTROL_RESOURCES);
    const actions = new Set<string>(ACCESS_CONTROL_ACTIONS);
    for (const [signature, candidate] of candidates) {
      expect(candidate.status).toBe("candidate");
      expect(resources.has(candidate.resource), signature).toBe(true);
      expect(actions.has(candidate.action), signature).toBe(true);
      expect(candidateAccessControlAction(signature)).toEqual(candidate);
    }
  });

  it("classifies POST according to business meaning, not HTTP verb", () => {
    expect(candidateAccessControlAction("POST /api/vouchers")).toMatchObject({
      resource: "erp.vouchers", action: "create",
    });
    expect(candidateAccessControlAction("POST /api/vouchers/:id/reverse")).toMatchObject({
      action: "reverse",
    });
    expect(candidateAccessControlAction("POST /api/factory/customer-orders/:id/finalize")).toMatchObject({
      action: "finalize",
    });
    expect(candidateAccessControlAction("POST /api/factory/raw-stock/recalculate-used")).toMatchObject({
      action: "repair",
    });
    expect(candidateAccessControlAction("POST /api/pos/retail/sales/:saleId/returns")).toMatchObject({
      action: "reverse",
    });
  });

  it("rejects unreviewed or misleading route signatures", () => {
    expect(candidateAccessControlAction("POST /api/factory/customer-orders/:id/unknown-action")).toBeNull();
    expect(candidateAccessControlAction("POST /api/vouchers/15")).toBeNull();
    expect(candidateAccessControlAction("DELETE /api/vouchers")).toBeNull();
    expect(candidateAccessControlAction("__proto__")).toBeNull();
  });

  it("never authorizes Create Only using a candidate mapping alone", () => {
    const candidate = candidateAccessControlAction("POST /api/vouchers");
    expect(candidate?.status).toBe("candidate");
    expect(evaluateAccessControl({
      role: CREATE_ONLY_ROLE,
      companyId: 1,
      isAssignedToCompany: true,
      routeVerified: candidate?.status === "verified",
      resource: candidate!.resource,
      action: candidate!.action,
      roleDecision: "allow",
      userDecision: "allow",
    }).allowed).toBe(false);
  });
});
