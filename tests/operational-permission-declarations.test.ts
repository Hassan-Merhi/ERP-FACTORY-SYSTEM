/**
 * Operational permissions (imports, bulk maintenance, exports, POS shifts) as
 * declared per route in config/route-access-manifest.json.
 *
 * These rules used to live in a separate method/path table with its own
 * middleware. They are now the `permission` and `roles.company` fields of each
 * route's access rule, enforced by the access boundary. This suite keeps the
 * declarations honest: every registered route whose path looks like an import,
 * export, print or repair must declare an operational permission or be
 * explicitly exempted here with a reason.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRuleId,
  permissionKeyOf,
  RouteAccessResolver,
  type RouteAccessManifest,
} from "../server/security/access/routeAccessManifest";

const manifest = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "config/route-access-manifest.json"), "utf8")
) as RouteAccessManifest;
const resolver = new RouteAccessResolver(manifest);

const OPERATIONAL_KEY = /^(act_|exp_|pos_perm_)/;

/** Non-module permission keys a rule declares. */
function operationalKeys(ruleId: string): string[] {
  const rule = manifest.routes.find((candidate) => candidate.id === ruleId);
  if (!rule || rule.permission === "none") return [];
  return rule.permission.map(permissionKeyOf).filter((key) => OPERATIONAL_KEY.test(key));
}

/** What a request must satisfy beyond its module permission. */
function required(method: string, requestPath: string) {
  const access = resolver.resolve(method, requestPath.split("?", 1)[0]);
  if (!access) return null;
  const permissions = access.permissions.filter((permission) => permission.type !== "module");
  return {
    keys: permissions.map((permission) => permission.key),
    types: permissions.map((permission) => permission.type),
    bypassRoles: permissions.flatMap((permission) => permission.bypassRoles),
    deniedRoles: access.companyRoles.flatMap((rule) => rule.deny ?? []),
    allowedRoles: access.companyRoles.flatMap((rule) => rule.allow ?? []),
    reasons: access.companyRoles.map((rule) => rule.reason),
  };
}

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
  "GET /api/factory/container-import-credit-preview":
    "Factory-admin, read-only preview of containers missing their import credit voucher (#2228); it posts nothing.",
  "GET /api/factory/bale-products/arabic-import/capabilities/import":
    "Capability probe that answers whether the user may import; the route checks act_import_data itself.",
  "POST /api/factory/raw-stock/recalc/mix-batches-preview": "Admin-only preview; it writes nothing.",
  "POST /api/factory/finalized-sale-returns/import-preview":
    "Admin/Developer-only, read-only match of uploaded bale references to finalized invoices (#3198); it writes nothing. Posting goes through /api/factory/finalized-sale-returns/apply.",
  "POST /api/factory/customer-orders/loading-list/automatic-print-preflight-batch":
    "Bale-label print preparation (Automatic Priority Printing); owned by the Factory label-printing pages in the backend access boundary, like /api/bale-label-prints. Not an invoice print.",
  "POST /api/factory/customer-orders/loading-list/automatic-print-preflight":
    "Single-bale form of the label print preparation above; same Factory page boundary. Not an invoice print.",
  "POST /api/factory/customer-orders/:id/container-extra-items/import":
    "Admin/Owner/Developer-only upload of validated workbook rows into one customer order's container extra items (same in-handler role gate as its GET/PUT/DELETE siblings); not a bulk company data import.",
  "GET /api/tickets/export":
    "Ticket admin CSV export (#2893); the route itself requires the dedicated exp_ticket_export permission through requireExportAccess in ticketReportingRoutes.ts, on top of the ticket page permission.",
  "GET /api/factory/monthly-production-matrix/export-bales":
    "Paged JSON read of the same bale rows the Monthly Production Matrix page already shows (#2892); gated by that page's factory access like its /bales and /workers siblings. The workbook is built client-side, so it is not a server Excel export.",
  "POST /api/stock-transfer-order/wa-approval/requests/:batchId/deliveries/:recipientKind/reconcile":
    "Stock Transfer Order WhatsApp Phase 6 delivery reconciliation: an Admin/Owner/Developer-only record of provider and chat evidence for an already approved batch's Excel delivery, with a capped manual retry. It posts no voucher and moves no stock; the route enforces the role and the active company itself. Recorded on 2026-11-11 so main can certify.",
  "GET /api/factory/customer-orders/:id/loading-dispatches/order-overview/trips/:dispatchId/invoice.xlsx":
    "Per-trip Factory invoice workbook (#3100): a read-only, company-scoped REPEATABLE READ download of one posted trip's own invoice lines, gated by requireAuth and the Factory invoicing loadings tab access (factory/invoicing) like its order-overview JSON siblings. Recorded on 2026-11-11 so main can certify; it has no dedicated export permission today, which the owner should confirm is intended.",
  "POST /api/intercompany-container-trading/import":
    "Owner/Developer-only upload that creates a linked intercompany container trade (the route's own requireRole guard); it had no import permission before the access layer and is not a company data import.",
  "GET /api/excel-export/appearance":
    "Reads the company's workbook colours and logo so exports can be styled; it produces no export.",
  "PUT /api/excel-export/appearance":
    "Admin/Developer-only save of the workbook appearance settings (the route's own requireRole guard and effective-role check); it produces no export.",
  "GET /api/pos/shifts/current":
    "Registered before GET /api/pos/shifts/:id; any POS user reads their own open shift, so it must not inherit the shift-summary permission.",
  "POST /api/pos/send-stock-pdf-backend":
    "Fast POS WhatsApp sender. It was registered ahead of the former operational-permission middleware, so exp_stock_report was listed for it but never enforced. Kept as it behaved; the owner should confirm whether POS stock PDFs should require the export permission.",
  "POST /api/pos/send-stock-pdf": "Same fast POS stock PDF sender under its second path; see above.",
  "POST /api/pos/send-invoice-pdf-backend":
    "Fast POS invoice sender; exp_pdf was listed but never enforced for the same registration-order reason. Kept as it behaved.",
  "POST /api/pos/send-whatsapp-pdf-upload":
    "Fast POS uploaded-PDF sender; exp_whatsapp_send was listed but never enforced for the same registration-order reason. Kept as it behaved.",
  "POST /api/pos/send-invoice-whatsapp":
    "Fast POS invoice sender under its second path; no export permission was ever listed for it.",
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

describe("operational permission declarations", () => {
  const routeKeys = [...new Set(manifest.routes.map((rule) => rule.id.replace(/#\d+$/, "")))];

  it("exempts only registered routes", () => {
    expect(Object.keys(REVIEWED_UNGUARDED_ROUTES).filter((entry) => !routeKeys.includes(entry))).toEqual([]);
  });

  it("requires an explicit decision for every route that looks operational", () => {
    const undecided = manifest.routes
      .filter((rule) => {
        const parsed = parseRuleId(rule.id)!;
        const key = `${parsed.method} ${parsed.path}`;
        if (!looksOperational(parsed.method, parsed.path) || key in REVIEWED_UNGUARDED_ROUTES) return false;
        // Registrations of one route are prerequisites of each other; one declaration covers them.
        return !manifest.routes.some(
          (other) => other.id.replace(/#\d+$/, "") === key && operationalKeys(other.id).length > 0
        );
      })
      .map((rule) => rule.id);
    expect(
      undecided,
      "Declare the operational permission on the route in config/route-access-manifest.json, or add it to REVIEWED_UNGUARDED_ROUTES with a reason"
    ).toEqual([]);
  });

  it("does not let a parameter route's permission land on a literal route registered beside it", () => {
    // GET /api/pos/shifts/:id needs the shift-summary permission; the literal
    // current-shift read registered before it must stay free of it.
    expect(required("GET", "/api/pos/shifts/current")?.keys).toEqual([]);
    expect(required("GET", "/api/pos/shifts/45")?.keys).toEqual(["pos_perm_view_shift_summary"]);
    // A literal export registered after a parameter route keeps its own permission.
    expect(required("GET", "/api/containers/export-all")?.keys).toEqual(["exp_excel"]);
    expect(required("GET", "/api/containers/45")?.keys).toEqual([]);
    expect(required("GET", "/api/git/containers/import-template.xlsx")?.keys).toEqual(["act_import_data"]);
    expect(required("GET", "/api/git/containers/45")?.keys).toEqual([]);
  });
});

describe("operational permission rules", () => {
  it("declares import workflows and leaves import-cycle reads alone", () => {
    expect(required("POST", "/api/po-import/import")).toMatchObject({
      keys: ["act_import_data"],
      types: ["action"],
      deniedRoles: ["POS", "View Only", "Create Only"],
      reasons: ["operational-task"],
    });
    expect(required("POST", "/api/stock-items/import")).toMatchObject({ keys: ["act_import_data"] });
    expect(required("GET", "/api/stats/import-cycle-balance")).toMatchObject({ keys: [], deniedRoles: [] });
  });

  it("allows POS-role access to normal and customer sales imports while keeping View Only blocked", () => {
    for (const prefix of ["/api/pos-import", "/api/credit-sales-import"]) {
      for (const [method, suffix] of [
        ["GET", "template"],
        ["POST", "parse"],
        ["POST", "validate"],
        ["POST", "import"],
      ]) {
        expect(required(method, `${prefix}/${suffix}`), `${method} ${prefix}/${suffix}`).toEqual({
          keys: ["act_import_data"],
          types: ["action"],
          bypassRoles: ["POS"],
          deniedRoles: ["View Only", "Create Only"],
          allowedRoles: [],
          reasons: ["operational-task"],
        });
      }
    }
  });

  it("protects the Arabic template through Excel export and import mutations through action access", () => {
    // The template route also carries its own requireActionAccess guard, so
    // the declaration lists both keys.
    expect(required("GET", "/api/factory/bale-products/arabic-template")?.keys).toEqual([
      "exp_excel",
      "act_import_data",
    ]);
    expect(required("POST", "/api/factory/bale-products/arabic-import/apply")).toMatchObject({
      keys: ["act_import_data"],
      types: ["action"],
      deniedRoles: ["POS", "View Only", "Create Only"],
    });
  });

  it("declares company-scoped repair and recalculation mutations", () => {
    expect(required("POST", "/api/admin/recalculate-equity-adjustment")).toMatchObject({
      keys: ["act_bulk_operations"],
      deniedRoles: ["POS", "View Only", "Create Only"],
    });
    expect(required("POST", "/api/intercompany-pos-config/rebuild")).toMatchObject({ keys: ["act_bulk_operations"] });
  });

  it("makes the all-company export center Developer-only", () => {
    expect(required("POST", "/api/export/start")).toEqual({
      keys: ["exp_backup_download"],
      types: ["export"],
      bypassRoles: [],
      deniedRoles: [],
      allowedRoles: ["Developer"],
      reasons: ["global-export-center"],
    });
  });

  it("uses specific export permissions", () => {
    expect(required("GET", "/api/factory/bales/stock-entry-history/export-pdf")).toMatchObject({
      keys: ["exp_stock_report"],
    });
    expect(required("GET", "/api/pos/invoice/7/pdf")).toMatchObject({ keys: ["exp_pdf"] });
    expect(required("POST", "/api/factory/pressing/create-and-print")).toMatchObject({ keys: ["exp_print_invoice"] });
  });

  it("declares POS shift controls and summaries, but not the current-shift read", () => {
    expect(required("POST", "/api/pos/shifts/open")).toMatchObject({ keys: ["pos_perm_open_shift"], types: ["pos"] });
    expect(required("POST", "/api/pos/shifts/45/close")).toMatchObject({ keys: ["pos_perm_open_shift"] });
    expect(required("GET", "/api/pos/shifts/history")).toMatchObject({ keys: ["pos_perm_view_shift_summary"] });
    expect(required("GET", "/api/pos/shifts/current")).toMatchObject({ keys: [] });
  });

  it("matches the way the app routes: exact case, a trailing slash, HEAD as GET, query ignored", () => {
    // Routing is case-sensitive (createHttpApp), so a differently-cased path
    // names no declared route; the boundary answers 404 before any handler.
    expect(required("POST", "/api/BALES/IMPORT")).toBeNull();
    expect(required("POST", "/api/bales/import/")).toMatchObject({ keys: ["act_import_data"] });
    expect(required("HEAD", "/api/pos/invoice/7/pdf")).toMatchObject({ keys: ["exp_pdf"] });
    expect(required("GET", "/api/pos/invoice/7/pdf?download=1")).toMatchObject({ keys: ["exp_pdf"] });
    expect(required("GET", "/api/pos/invoice/7/8/pdf")).toBeNull();
  });

  it("does not guess from words in unregistered or ordinary paths", () => {
    expect(required("GET", "/api/invoices/7/pdf")).toBeNull();
    expect(required("POST", "/api/bales/import")?.keys).toEqual(["act_import_data"]);
    // GET at the import URL is served by the record route, which needs no import permission.
    expect(required("GET", "/api/bales/import")?.keys).toEqual([]);
  });
});
