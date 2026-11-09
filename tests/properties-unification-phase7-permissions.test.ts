import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";

const permissionContext = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../server/services/security/activeCompanyPermissionContext", async (importOriginal) => {
  const original = await importOriginal<typeof import("../server/services/security/activeCompanyPermissionContext")>();
  return { ...original, getActiveCompanyPermissionContext: permissionContext.get };
});

import {
  mayDeleteRentalRecords,
  requireRentalDeletePermission,
  requireRentalReconciliationPermission,
} from "../server/routes/rental/rentalRoutePermissions";
import { ActiveCompanyPermissionContextError } from "../server/services/security/activeCompanyPermissionContext";

function responseDouble() {
  const res: any = { statusCode: 200, body: null };
  res.status = vi.fn((status: number) => { res.statusCode = status; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  return res;
}

function requestDouble() {
  // Simulate a previously authorized session after its active-company role
  // changed. Only the current database-derived company context may authorize.
  return { session: { currentRole: "Developer", canDeleteRecords: true, currentCompanyId: 13 } } as any;
}

function activeContext(role: string, canDeleteRecords = false, companyId = 13) {
  return { userId: "user-1", role, canDeleteRecords, companyId };
}

describe("Phase 7 rental active-company authorization", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["Admin", false, true],
    ["Developer", false, true],
    ["Owner", false, true],
    ["Manager", true, true],
    ["Manager", false, false],
    ["Normal User", true, true],
    ["Normal User", false, false],
    ["POS", true, false],
    ["View Only", true, false],
    ["Create Only", true, false],
    ["ERP Tester", true, false],
  ] as const)("delete policy for %s (flag=%s)", (role, flag, permitted) => {
    expect(mayDeleteRentalRecords(role, flag)).toBe(permitted);
  });

  it("denies payment deletion after the active-company assignment loses permission even if session is privileged", async () => {
    permissionContext.get.mockResolvedValue(activeContext("Manager", false));
    const next = vi.fn();
    const res = responseDouble();
    await requireRentalDeletePermission(requestDouble(), res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows deletion only when the active company grants it", async () => {
    permissionContext.get.mockResolvedValue(activeContext("Manager", true, 20));
    const next = vi.fn();
    await requireRentalDeletePermission(requestDouble(), responseDouble(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("uses the selected-company role for reconciliation, never the stale Developer session", async () => {
    permissionContext.get.mockResolvedValue(activeContext("Owner", true));
    const next = vi.fn();
    const res = responseDouble();
    await requireRentalReconciliationPermission(requestDouble(), res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(["Admin", "Developer"])("allows %s reconciliation", async (role) => {
    permissionContext.get.mockResolvedValue(activeContext(role));
    const next = vi.fn();
    await requireRentalReconciliationPermission(requestDouble(), responseDouble(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed when there is no valid active company", async () => {
    permissionContext.get.mockRejectedValue(new ActiveCompanyPermissionContextError(
      "You no longer have access to the active company.", 403, "ACTIVE_COMPANY_ROLE_REQUIRED",
    ));
    const next = vi.fn();
    const res = responseDouble();
    await requireRentalDeletePermission(requestDouble(), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("ACTIVE_COMPANY_ROLE_REQUIRED");
    expect(next).not.toHaveBeenCalled();
  });

  it("passes unexpected context errors to the Express error handler", async () => {
    const error = new Error("database unavailable");
    permissionContext.get.mockRejectedValue(error);
    const next = vi.fn();
    await requireRentalDeletePermission(requestDouble(), responseDouble(), next);
    expect(next).toHaveBeenCalledWith(error);
  });
});

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

describe("Phase 7 rental route wiring", () => {
  it("protects posted and scheduled payment deletion after authentication", () => {
    expect(source("../server/routes/rental/centralRentalPaymentDeletionRoute.ts"))
      .toMatch(/app\.delete\(`${urlPrefix}\/payments\/:id`, requireAuth, requireRentalDeletePermission,/);
    expect(source("../server/routes/rental/rentalPaymentsAccrualRoutes.ts"))
      .toMatch(/app\.delete\(`${urlPrefix}\/payments\/scheduled\/:groupId`, requireAuth, requireRentalDeletePermission,/);
  });

  it("protects reconciliation with the active company role", () => {
    expect(source("../server/routes/rentalRouteFactory.ts"))
      .toMatch(/app\.get\(`${urlPrefix}\/reconciliation`, requireAuth, requireRentalReconciliationPermission,/);
  });
});
