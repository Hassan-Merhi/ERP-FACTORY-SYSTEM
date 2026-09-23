import { describe, expect, it } from "vitest";
import {
  classifyPrivilegedMaintenanceRoute,
  decidePrivilegedMaintenanceAccess,
  PRIVILEGED_MAINTENANCE_PERMISSION,
} from "../server/services/security/privilegedMaintenanceRoutePolicy";

describe("Wave 3 privileged maintenance route policy", () => {
  it.each([
    ["POST", "/api/admin/repair-inventory-values", "repair"],
    ["POST", "/api/admin/recalculate-equity-adjustment", "recalculate"],
    ["POST", "/api/admin/rebuild-inventory", "rebuild"],
    ["POST", "/api/cleanup/orphaned-charges", "cleanup"],
    ["POST", "/api/po-import/backfill", "backfill"],
    ["POST", "/api/admin/po-supplier-reconciliation", "reconcile"],
    ["PATCH", "/api/factory/resync-costs/12", "resync"],
    ["DELETE", "/api/admin/fix-orphaned-pos-data", "fix"],
  ])("classifies %s %s as %s maintenance", (method, path, operation) => {
    expect(classifyPrivilegedMaintenanceRoute(method, path)).toEqual({
      operation,
      permission: PRIVILEGED_MAINTENANCE_PERMISSION,
    });
  });

  it("does not turn ordinary business writes or maintenance reads into privileged mutations", () => {
    expect(classifyPrivilegedMaintenanceRoute("POST", "/api/vouchers")).toBeNull();
    expect(classifyPrivilegedMaintenanceRoute("GET", "/api/admin/repair-inventory-values/preview")).toBeNull();
    expect(classifyPrivilegedMaintenanceRoute("GET", "/api/po-import/backfill")).toBeNull();
  });

  it("requires Admin plus the exact company repair permission", () => {
    expect(
      decidePrivilegedMaintenanceAccess({
        role: "Admin",
        developerBypass: false,
        permissions: [PRIVILEGED_MAINTENANCE_PERMISSION],
      })
    ).toEqual({ allowed: true, code: "AUTHORIZED" });

    expect(
      decidePrivilegedMaintenanceAccess({
        role: "Admin",
        developerBypass: false,
        permissions: [],
      })
    ).toEqual({
      allowed: false,
      code: "PRIVILEGED_MAINTENANCE_PERMISSION_REQUIRED",
    });
  });

  it.each(["Owner", "Manager", "POS", "Normal User", "View Only"])(
    "does not inherit repair authority from the legacy %s role",
    (role) => {
      expect(
        decidePrivilegedMaintenanceAccess({
          role,
          developerBypass: false,
          permissions: [PRIVILEGED_MAINTENANCE_PERMISSION],
        })
      ).toEqual({
        allowed: false,
        code: "PRIVILEGED_MAINTENANCE_ROLE_REQUIRED",
      });
    }
  );

  it("preserves the explicit Developer global support boundary", () => {
    expect(
      decidePrivilegedMaintenanceAccess({
        role: "Developer",
        developerBypass: true,
        permissions: [],
      })
    ).toEqual({ allowed: true, code: "AUTHORIZED" });

    expect(
      decidePrivilegedMaintenanceAccess({
        role: "Developer",
        developerBypass: false,
        permissions: [PRIVILEGED_MAINTENANCE_PERMISSION],
      })
    ).toEqual({
      allowed: false,
      code: "PRIVILEGED_MAINTENANCE_ROLE_REQUIRED",
    });
  });
});
