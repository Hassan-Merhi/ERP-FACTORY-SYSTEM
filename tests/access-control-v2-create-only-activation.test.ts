import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ get: vi.fn() }));
const permissions = vi.hoisted(() => ({ rows: [] as Array<{ role: string; featureKey: string; enabled: boolean }> }));
vi.mock("../server/services/security/activeCompanyPermissionContext", () => ({
  getActiveCompanyPermissionContext: context.get,
  ActiveCompanyPermissionContextError: class ActiveCompanyPermissionContextError extends Error {
    constructor(
      message: string,
      public readonly status: 401 | 403,
      public readonly code: string
    ) {
      super(message);
    }
  },
}));
vi.mock("../server/storage", () => ({
  storage: { getRoleFeaturePermissions: vi.fn(async () => permissions.rows) },
}));

import {
  CREATE_ONLY_VERIFIED_CREATE_SIGNATURES,
  isCreateOnlyVerifiedCreate,
  isCreateOnlyWriteBlocked,
} from "../server/services/security/createOnlyWritePolicy";
import { isViewOnlyWriteBlocked } from "../server/services/security/viewOnlyWritePolicy";
import {
  CREATE_ONLY_MAX_BALES_PER_BATCH,
  createOnlyRequestRules,
  firstDayOfMonth,
} from "../server/services/security/createOnlyRequestRules";
import { requireCreateOnlyVerifiedCreate } from "../server/services/security/createOnlyVerifiedCreates";
import {
  isCreateOnlyAssignmentEnabled,
  refuseInactiveCreateOnlyAssignment,
} from "../server/services/security/createOnlyActivation";
import { buildPermissionMap, canAccess } from "../server/lib/permissionHelpers";
import { getTrustedClientDate } from "../server/lib/dateUtils";
import { canModifyDate } from "../server/auth";
import { isPosMutationAllowed } from "../server/services/security/posOperationalPermissionPolicy";
import { effectiveErpPageKeys } from "../server/services/security/erpViewerPagePolicy";
import { canEmptyFactoryLoadingContainer } from "../shared/factoryPermissionCatalog";
import { isCreateOnlyFeatureAllowed, isExistingRecordReadOnlyRole } from "../shared/createOnlyRolePolicy";
import { PHASE9_HANDLERS } from "../server/edge/phase9OperatorApply";

const LEGACY_ROLES = ["Developer", "Admin", "Owner", "Manager", "POS", "Normal User", "View Only", "ERP Tester"];
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config/route-manifest.json"), "utf8")) as {
  routes: string[];
};
const writes = manifest.routes
  .map((row) => /^([A-Z-]+) (\/\S+) \[/.exec(row))
  .filter((match): match is RegExpExecArray => match !== null)
  .filter((match) => !["GET", "HEAD", "OPTIONS"].includes(match[1]) && match[2].startsWith("/api/"));
const verifiedSignatures = Object.values(CREATE_ONLY_VERIFIED_CREATE_SIGNATURES).flat();

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}

describe("Create Only global write boundary", () => {
  it("blocks every registered business write except the handler-verified creates", () => {
    expect(writes.length).toBeGreaterThan(1000);
    for (const [, method, routePath] of writes) {
      const blocked = isCreateOnlyWriteBlocked("Create Only", method, routePath);
      const signature = `${method} ${routePath}`;
      // Everything View Only may do (sign-in, presence, screen-feed transport)
      // plus the verified creates is the complete set Create Only may reach.
      const allowed = !isViewOnlyWriteBlocked("View Only", method, routePath) || verifiedSignatures.includes(signature);
      expect(blocked, signature).toBe(!allowed);
    }
  });

  it("never changes what the existing roles may write", () => {
    for (const role of LEGACY_ROLES) {
      for (const [, method, routePath] of writes) {
        expect(isCreateOnlyWriteBlocked(role, method, routePath), `${role} ${method} ${routePath}`).toBe(false);
      }
    }
  });

  it("matches verified creates exactly, never by prefix, case or alternative verb", () => {
    for (const signature of verifiedSignatures) {
      const [method, routePath] = signature.split(" ");
      expect(isCreateOnlyVerifiedCreate(method, routePath)).toBe(true);
      expect(isCreateOnlyWriteBlocked("Create Only", method.toLowerCase(), routePath)).toBe(false);
      for (const verb of ["PUT", "PATCH", "DELETE"]) {
        expect(isCreateOnlyWriteBlocked("Create Only", verb, routePath), `${verb} ${routePath}`).toBe(true);
      }
      expect(isCreateOnlyWriteBlocked("Create Only", method, `${routePath}/`)).toBe(true);
      expect(isCreateOnlyWriteBlocked("Create Only", method, `${routePath}/1`)).toBe(true);
      expect(isCreateOnlyWriteBlocked("Create Only", method, `${routePath}/bulk-delete`)).toBe(true);
      expect(isCreateOnlyWriteBlocked("Create Only", method, routePath.toUpperCase())).toBe(true);
    }
  });

  it("denies edits, deletes, approvals, reversals, imports and bulk routes", () => {
    const samples = [
      "PUT /api/suppliers/12",
      "DELETE /api/customers/3",
      "POST /api/vouchers",
      "POST /api/vouchers/journal",
      "POST /api/vouchers/bulk-delete",
      "PATCH /api/vouchers/9/adjustment",
      "POST /api/containers/4/offload",
      "POST /api/factory/mix-batches",
      "POST /api/factory/payrolls/generate-bulk",
      "POST /api/pos/retail/sales",
      "POST /api/pos/retail/transfers",
      "POST /api/properties/rental/payments",
      "POST /api/user-company-roles",
      "PUT /api/permissions-v2/role-rules",
    ];
    for (const sample of samples) {
      const [method, routePath] = sample.split(" ");
      expect(isCreateOnlyWriteBlocked("Create Only", method, routePath), sample).toBe(true);
    }
  });

  it("puts every verified create on a registered route that carries the named guard", () => {
    for (const signature of verifiedSignatures) {
      const row = manifest.routes.find((entry) => entry.startsWith(`${signature} [`));
      expect(row, signature).toBeDefined();
      expect(row, signature).toContain("createOnlyVerifiedCreate");
    }
  });
});

describe("Create Only per-route request rules", () => {
  it("refuses opening balances, linked ledgers and opening stock", () => {
    expect(createOnlyRequestRules.customer({ name: "A" })).toBe(false);
    expect(createOnlyRequestRules.customer({ name: "A", openingBalance: "0" })).toBe(false);
    expect(createOnlyRequestRules.customer({ name: "A", openingBalance: "125.50" })).toBe(true);
    expect(createOnlyRequestRules.customer({ name: "A", openingBalance: "abc" })).toBe(true);
    expect(createOnlyRequestRules.customer({ name: "A", ledgerAccountId: 44 })).toBe(true);
    expect(createOnlyRequestRules.stockItem({ name: "Item", openingQty: 0, openingRate: "0" })).toBe(false);
    expect(createOnlyRequestRules.stockItem({ name: "Item", openingQty: 5 })).toBe(true);
    expect(createOnlyRequestRules.stockItem({ name: "Item", openingValue: "10" })).toBe(true);
  });

  it("caps bale batch volume and requires a sane bale weight", () => {
    expect(createOnlyRequestRules.baleBatch({ quantity: 10, weightPerBale: 45 })).toBe(false);
    expect(createOnlyRequestRules.baleBatch({ quantity: CREATE_ONLY_MAX_BALES_PER_BATCH + 1, weightPerBale: 45 })).toBe(
      true
    );
    expect(createOnlyRequestRules.baleBatch({ quantity: 0, weightPerBale: 45 })).toBe(true);
    expect(createOnlyRequestRules.baleBatch({ quantity: 2, weightPerBale: -1 })).toBe(true);
    expect(createOnlyRequestRules.baleBatch({ quantity: 2, weightPerBale: "x" })).toBe(true);
  });

  it("keeps a new customer order a plain draft", () => {
    const draft = { customerId: 4, orderDate: "2026-11-07", notes: "n" };
    expect(createOnlyRequestRules.customerOrderFields(draft)).toBe(false);
    expect(createOnlyRequestRules.customerOrderFields({ ...draft, status: "DRAFT", grandTotal: "0" })).toBe(false);
    for (const extra of [
      { status: "FINALIZED" },
      { verifiedAt: "2026-11-07" },
      { invoiceNumber: "INV-1" },
      { grandTotal: "500" },
      { totalQtyBales: 12 },
      { isHidden: true },
      { bookingInfo: "BK-1" },
      { dispatchBatchId: 3 },
    ]) {
      expect(createOnlyRequestRules.customerOrderFields({ ...draft, ...extra }), JSON.stringify(extra)).toBe(true);
    }
  });

  it("keeps rental units and contracts new, current and in this company", () => {
    const today = "2026-11-07";
    expect(createOnlyRequestRules.rentalUnit({ unitNumber: "A1" })).toBe(false);
    expect(createOnlyRequestRules.rentalUnit({ unitNumber: "A1", active: false })).toBe(true);
    const contract = { unitId: 3, startDate: "2026-11-01", monthlyRent: "500" };
    expect(createOnlyRequestRules.rentalContract(contract, today)).toBe(false);
    expect(createOnlyRequestRules.rentalContract({ ...contract, startDate: "2026-10-31" }, today)).toBe(true);
    expect(createOnlyRequestRules.rentalContract({ ...contract, startDate: "" }, today)).toBe(true);
    expect(createOnlyRequestRules.rentalContract({ ...contract, status: "ENDED" }, today)).toBe(true);
    expect(createOnlyRequestRules.rentalContract({ ...contract, linkedCompanyId: 9 }, today)).toBe(true);
    expect(createOnlyRequestRules.rentalContract({ ...contract, isInternal: true }, today)).toBe(true);
    expect(createOnlyRequestRules.rentalContract({ ...contract, guaranteePostedToStatement: true }, today)).toBe(true);
    expect(createOnlyRequestRules.rentalContract({ ...contract, guaranteePostedAmount: "10" }, today)).toBe(true);
    expect(firstDayOfMonth(today)).toBe("2026-11-01");
  });

  it("refuses opening stock and edit markers on new retail products", () => {
    expect(createOnlyRequestRules.retailProduct({ name: "Shirt" })).toBe(false);
    expect(createOnlyRequestRules.retailProduct({ name: "Shirt", variants: [{ sku: "S" }] })).toBe(false);
    expect(createOnlyRequestRules.retailProduct({ name: "Shirt", variants: [{ sku: "S", stocks: [] }] })).toBe(false);
    expect(
      createOnlyRequestRules.retailProduct({ variants: [{ sku: "S", stocks: [{ locationId: 1, quantity: 3 }] }] })
    ).toBe(true);
    expect(createOnlyRequestRules.retailProduct({ variants: [{ id: 7, sku: "S" }] })).toBe(true);
    expect(createOnlyRequestRules.retailProduct({ variants: "not-an-array" })).toBe(true);
  });

  it("dates SP sales today only", () => {
    expect(createOnlyRequestRules.spSale({ saleDate: "2026-11-07" }, "2026-11-07")).toBe(false);
    expect(createOnlyRequestRules.spSale({}, "2026-11-07")).toBe(false);
    expect(createOnlyRequestRules.spSale({ saleDate: "2026-11-06" }, "2026-11-07")).toBe(true);
    expect(createOnlyRequestRules.spSale({ saleDate: "2026-11-08" }, "2026-11-07")).toBe(true);
  });
});

describe("Create Only per-route guard middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.rows = [];
    context.get.mockResolvedValue({ role: "Create Only", companyId: 7, developerBypass: false });
  });
  const createOnlyRequest = (body: unknown) =>
    ({ body, headers: {}, session: { currentRole: "Create Only", currentCompanyId: 7 } }) as never;

  it("lets a clean new supplier through and refuses an opening balance before the handler runs", async () => {
    const guard = requireCreateOnlyVerifiedCreate("suppliers");
    const allowed = vi.fn();
    await guard(createOnlyRequest({ name: "New supplier" }), response() as never, allowed);
    expect(allowed).toHaveBeenCalledOnce();

    const denied = vi.fn();
    const res = response();
    await guard(createOnlyRequest({ name: "New supplier", openingBalance: "900" }), res as never, denied);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(denied).not.toHaveBeenCalled();
  });

  it("follows the company's page settings for the role", async () => {
    permissions.rows = [{ role: "Create Only", featureKey: "page_customers", enabled: false }];
    const next = vi.fn();
    const res = response();
    await requireCreateOnlyVerifiedCreate("customers")(createOnlyRequest({ name: "C" }), res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes every other role straight to the existing route guards", async () => {
    for (const role of LEGACY_ROLES) {
      const next = vi.fn();
      const req = { body: { openingBalance: "900" }, headers: {}, session: { currentRole: role } } as never;
      await requireCreateOnlyVerifiedCreate("suppliers")(req, response() as never, next);
      expect(next, role).toHaveBeenCalledOnce();
    }
    expect(context.get).not.toHaveBeenCalled();
  });

  it("refuses when the canonical membership is no longer Create Only in this company", async () => {
    context.get.mockResolvedValueOnce({ role: "Create Only", companyId: 0, developerBypass: false });
    const next = vi.fn();
    const res = response();
    await requireCreateOnlyVerifiedCreate("stockItems")(createOnlyRequest({ name: "I" }), res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("Create Only dates", () => {
  const now = new Date("2026-11-07T10:00:00Z");
  const withHeader = (value?: string) => ({ headers: value ? { "x-client-date": value } : {} }) as never;

  it("accepts the browser date only within a day of the server date", () => {
    expect(getTrustedClientDate(withHeader("2026-11-07"), now)).toBe("2026-11-07");
    expect(getTrustedClientDate(withHeader("2026-11-08"), now)).toBe("2026-11-08");
    expect(getTrustedClientDate(withHeader("2026-11-06"), now)).toBe("2026-11-06");
    expect(getTrustedClientDate(withHeader("2026-10-01"), now)).toBe("2026-11-07");
    expect(getTrustedClientDate(withHeader("garbage"), now)).toBe("2026-11-07");
    expect(getTrustedClientDate(withHeader(), now)).toBe("2026-11-07");
  });

  it("refuses backdated or forged-date records for Create Only", async () => {
    const today = new Date().toISOString().split("T")[0];
    const run = async (voucherDate: string, header?: string) => {
      const next = vi.fn();
      const res = response();
      const req = {
        user: { role: "Create Only" },
        body: { voucherDate },
        headers: header ? { "x-client-date": header } : {},
        session: {},
      } as never;
      await canModifyDate("voucherDate")(req, res as never, next);
      return { next, res };
    };
    expect((await run(today)).next).toHaveBeenCalledOnce();
    const backdated = await run("2020-01-01", "2020-01-01");
    expect(backdated.res.status).toHaveBeenCalledWith(403);
    expect(backdated.next).not.toHaveBeenCalled();
  });
});

describe("Create Only feature permissions and read parity", () => {
  it("never grants settings, approvals, imports, bulk or POS overrides, whatever is stored", () => {
    const stored = ["mod_settings", "act_approve_voucher", "act_import_data", "act_bulk_operations", "pos_perm_refund"];
    const map = buildPermissionMap(
      stored.map((featureKey) => ({ role: "Create Only", featureKey, enabled: true })),
      "Create Only"
    );
    for (const key of stored) expect(canAccess("Create Only", key, map), key).toBe(false);
  });

  it("keeps money fields hidden unless an administrator enables them", () => {
    expect(isCreateOnlyFeatureAllowed("fld_cost_price", undefined)).toBe(false);
    expect(isCreateOnlyFeatureAllowed("fld_cost_price", true)).toBe(true);
    expect(isCreateOnlyFeatureAllowed("page_suppliers", undefined)).toBe(true);
    expect(isCreateOnlyFeatureAllowed("page_suppliers", false)).toBe(false);
  });

  it("reads like View Only and is refused where View Only is refused", () => {
    expect(effectiveErpPageKeys("Create Only", [])).toEqual(effectiveErpPageKeys("View Only", []));
    expect(isPosMutationAllowed({ method: "POST", role: "Create Only", posViewOnly: false })).toBe(false);
    expect(canEmptyFactoryLoadingContainer({ role: "Create Only", hasFactoryAccess: true })).toBe(false);
    expect(isExistingRecordReadOnlyRole("Create Only")).toBe(true);
    expect(isExistingRecordReadOnlyRole("Manager")).toBe(false);
  });
});

describe("Create Only offline sync", () => {
  it("refuses every offline apply event from a Create Only actor before reading business data", async () => {
    const handlers = Object.entries(PHASE9_HANDLERS) as Array<
      [string, { authorize: (client: unknown, event: unknown) => Promise<unknown> }]
    >;
    expect(handlers.length).toBeGreaterThan(10);
    for (const [kind, handler] of handlers) {
      const query = vi.fn(async () => ({ rows: [{ active: true, role: "Create Only", pos_view_only: false }] }));
      const event = { kind, actorUserId: "user-1", companyId: 7, payload: {} };
      await expect(handler.authorize({ query }, event), kind).rejects.toThrow("PHASE9_ACTOR_ROLE_NOT_PERMITTED");
      expect(query, kind).toHaveBeenCalledTimes(1);
    }
  });
});

describe("Create Only assignment activation", () => {
  it("is off unless explicitly enabled", () => {
    expect(isCreateOnlyAssignmentEnabled({})).toBe(false);
    expect(isCreateOnlyAssignmentEnabled({ PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT: "true" })).toBe(false);
    expect(isCreateOnlyAssignmentEnabled({ PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT: "enabled" })).toBe(true);
  });

  it("refuses new Create Only assignments until activated, never other roles", () => {
    expect(refuseInactiveCreateOnlyAssignment({ requestedRole: "Create Only" }, {})?.status).toBe(409);
    expect(
      refuseInactiveCreateOnlyAssignment({ requestedRole: "Create Only", previousRole: "Manager" }, {})?.code
    ).toBe("CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED");
    expect(refuseInactiveCreateOnlyAssignment({ requestedRole: "Create Only", previousRole: "Create Only" }, {})).toBe(
      null
    );
    expect(
      refuseInactiveCreateOnlyAssignment(
        { requestedRole: "Create Only" },
        { PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT: "enabled" }
      )
    ).toBe(null);
    for (const role of LEGACY_ROLES) expect(refuseInactiveCreateOnlyAssignment({ requestedRole: role }, {})).toBe(null);
  });
});
