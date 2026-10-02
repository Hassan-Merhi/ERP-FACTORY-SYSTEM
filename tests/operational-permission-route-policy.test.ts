import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyOperationalPermissionRoute,
  OPERATIONAL_PERMISSION_FREE_ROUTES,
  OPERATIONAL_PERMISSIONS,
  OPERATIONAL_ROUTE_PERMISSIONS,
  type OperationalPermissionName,
} from "../server/services/security/operationalPermissionRoutePolicy";

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config/route-manifest.json"), "utf8")) as {
  routes: string[];
};
const registeredRoutes = [...new Set(manifest.routes.map((entry) => entry.split(" ", 2).join(" ")))];

const listedEntries = (
  Object.entries(OPERATIONAL_ROUTE_PERMISSIONS) as Array<[OperationalPermissionName, readonly string[]]>
).flatMap(([name, entries]) => entries.map((entry) => ({ name, entry })));

/**
 * Registered routes whose path reads like an import, export, print or repair
 * but that deliberately need no operational permission. Each needs a reason.
 */
const REVIEWED_UNGUARDED_ROUTES: Record<string, string> = {
  "GET /api/stats/import-cycle-balance": "Import-cycle balance is a dashboard read, not an import.",
  "GET /api/stats/import-cycle-diagnostics": "Import-cycle diagnostics is a read, not an import.",
  "GET /api/debug/import-cycle": "Import-cycle debug read with its own guard chain; not an import.",
  "GET /api/factory/bale-import-batches": "History of past bale imports; a read, not an import.",
  "GET /api/factory/bale-import-batches/:id/bales": "Bales of a past import batch; a read, not an import.",
  "GET /api/factory/bale-products/arabic-import/capabilities/import":
    "Capability probe that answers whether the user may import; the route checks act_import_data itself.",
  "POST /api/factory/raw-stock/recalc/mix-batches-preview": "Admin-only preview; it writes nothing.",
};

const MUTATION = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Review net only: decides which routes need an explicit decision, never what a request needs. */
function looksOperational(method: string, routePath: string): boolean {
  const lower = routePath.toLowerCase();
  if (/(?:^|[-/.])(import|export|excel|xlsx|pdf|print|backup-download)(?:[-/.]|$)/.test(lower)) return true;
  if (lower.startsWith("/api/pos/shifts")) return true;
  return (
    MUTATION.has(method) &&
    /(?:^|[-/])(repair|recalculate|recalc|rebuild|cleanup|backfill|reconcile|resync|fix)(?:[-/]|$)/.test(lower)
  );
}

function concrete(routePath: string, sample = "1"): string {
  return routePath.replace(/:[A-Za-z0-9_]+/g, sample);
}

describe("operational permission route table", () => {
  it("lists only registered routes, each once", () => {
    const all = [...listedEntries.map(({ entry }) => entry), ...OPERATIONAL_PERMISSION_FREE_ROUTES];
    expect(all.filter((entry, index) => all.indexOf(entry) !== index)).toEqual([]);
    expect(all.filter((entry) => !registeredRoutes.includes(entry))).toEqual([]);
    expect(Object.keys(REVIEWED_UNGUARDED_ROUTES).filter((entry) => !registeredRoutes.includes(entry))).toEqual([]);
  });

  it("resolves every listed route to its own permission", () => {
    for (const { name, entry } of listedEntries) {
      const [method, routePath] = entry.split(" ");
      expect(classifyOperationalPermissionRoute(method, concrete(routePath)), entry).toBe(
        OPERATIONAL_PERMISSIONS[name]
      );
    }
  });

  it("requires an explicit decision for every route that looks operational", () => {
    const decided = new Set([
      ...listedEntries.map(({ entry }) => entry),
      ...OPERATIONAL_PERMISSION_FREE_ROUTES,
      ...Object.keys(REVIEWED_UNGUARDED_ROUTES),
    ]);
    const undecided = registeredRoutes.filter((entry) => {
      const [method, routePath] = entry.split(" ");
      return looksOperational(method, routePath) && !decided.has(entry);
    });
    expect(
      undecided,
      "List these in OPERATIONAL_ROUTE_PERMISSIONS, or in REVIEWED_UNGUARDED_ROUTES with a reason"
    ).toEqual([]);
  });

  it("does not let a listed parameter route's permission land on another registered route", () => {
    const listed = new Set(listedEntries.map(({ entry }) => entry));
    const free = new Set(OPERATIONAL_PERMISSION_FREE_ROUTES);
    const leaks = registeredRoutes.filter((entry) => {
      if (listed.has(entry) || free.has(entry)) return false;
      const [method, routePath] = entry.split(" ");
      return classifyOperationalPermissionRoute(method, concrete(routePath, "x")) !== null;
    });
    expect(leaks, "Add the route to OPERATIONAL_PERMISSION_FREE_ROUTES or list it with its permission").toEqual([]);
  });
});

describe("operational permission route policy", () => {
  it("classifies import workflows and leaves import-cycle reads alone", () => {
    expect(classifyOperationalPermissionRoute("POST", "/api/po-import/import")).toMatchObject({
      operation: "import",
      permissionKey: "act_import_data",
      deniedRoles: ["POS", "View Only"],
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/stock-items/import")).toMatchObject({
      operation: "import",
      permissionKey: "act_import_data",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/stats/import-cycle-balance")).toBeNull();
  });

  it("allows POS-role access to normal and customer sales imports while keeping View Only blocked", () => {
    for (const prefix of ["/api/pos-import", "/api/credit-sales-import"]) {
      for (const [method, suffix] of [
        ["GET", "template"],
        ["POST", "parse"],
        ["POST", "validate"],
        ["POST", "import"],
      ]) {
        expect(classifyOperationalPermissionRoute(method, `${prefix}/${suffix}`)).toEqual({
          operation: "import",
          permissionType: "action",
          permissionKey: "act_import_data",
          deniedRoles: ["View Only"],
          permissionBypassRoles: ["POS"],
        });
      }
    }
  });

  it("protects the Arabic template through Excel export and import mutations through action access", () => {
    expect(classifyOperationalPermissionRoute("GET", "/api/factory/bale-products/arabic-template")).toMatchObject({
      operation: "excel-export",
      permissionType: "export",
      permissionKey: "exp_excel",
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/factory/bale-products/arabic-import/apply")).toMatchObject({
      operation: "import",
      permissionType: "action",
      permissionKey: "act_import_data",
      deniedRoles: ["POS", "View Only"],
    });
  });

  it("classifies company-scoped repair and recalculation mutations", () => {
    expect(classifyOperationalPermissionRoute("POST", "/api/admin/recalculate-equity-adjustment")).toMatchObject({
      operation: "bulk-maintenance",
      permissionKey: "act_bulk_operations",
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/intercompany-pos-config/rebuild")).toMatchObject({
      operation: "bulk-maintenance",
    });
  });

  it("makes the all-company export center Developer-only", () => {
    expect(classifyOperationalPermissionRoute("POST", "/api/export/start")).toEqual({
      operation: "global-export-center",
      permissionType: "export",
      permissionKey: "exp_backup_download",
      developerOnly: true,
    });
  });

  it("uses specific export permissions", () => {
    expect(
      classifyOperationalPermissionRoute("GET", "/api/factory/bales/stock-entry-history/export-pdf")
    ).toMatchObject({ operation: "stock-export", permissionKey: "exp_stock_report" });
    expect(classifyOperationalPermissionRoute("GET", "/api/pos/invoice/7/pdf")).toMatchObject({
      operation: "pdf-export",
      permissionKey: "exp_pdf",
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/factory/pressing/create-and-print")).toMatchObject({
      operation: "print",
      permissionKey: "exp_print_invoice",
    });
  });

  it("classifies POS shift controls and summaries, but not the current-shift read", () => {
    expect(classifyOperationalPermissionRoute("POST", "/api/pos/shifts/open")).toMatchObject({
      operation: "pos-shift-control",
      permissionType: "pos",
      permissionKey: "pos_perm_open_shift",
    });
    expect(classifyOperationalPermissionRoute("POST", "/api/pos/shifts/45/close")).toMatchObject({
      operation: "pos-shift-control",
      permissionKey: "pos_perm_open_shift",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/pos/shifts/history")).toMatchObject({
      operation: "pos-shift-summary",
      permissionKey: "pos_perm_view_shift_summary",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/pos/shifts/current")).toBeNull();
  });

  it("matches the way Express routes: any letter case, a trailing slash, HEAD as GET, query ignored", () => {
    expect(classifyOperationalPermissionRoute("POST", "/api/BALES/IMPORT")).toMatchObject({ operation: "import" });
    expect(classifyOperationalPermissionRoute("POST", "/api/bales/import/")).toMatchObject({ operation: "import" });
    expect(classifyOperationalPermissionRoute("HEAD", "/api/pos/invoice/7/pdf")).toMatchObject({
      operation: "pdf-export",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/pos/invoice/7/pdf?download=1")).toMatchObject({
      operation: "pdf-export",
    });
    expect(classifyOperationalPermissionRoute("GET", "/api/pos/invoice/7/8/pdf")).toBeNull();
  });

  it("does not guess from words in unregistered or ordinary paths", () => {
    expect(classifyOperationalPermissionRoute("GET", "/api/reports/sales")).toBeNull();
    expect(classifyOperationalPermissionRoute("GET", "/api/invoices/7/pdf")).toBeNull();
    expect(classifyOperationalPermissionRoute("POST", "/api/bales/import")).not.toBeNull();
    expect(classifyOperationalPermissionRoute("GET", "/api/bales/import")).toBeNull();
  });
});
