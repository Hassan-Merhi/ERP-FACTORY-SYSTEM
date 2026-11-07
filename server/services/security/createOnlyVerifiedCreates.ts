/**
 * Handler-verified Create Only business writes.
 *
 * Every entry was reviewed against its route handler and the services it calls
 * (see docs/permissions-control-center-phase3-route-review.md). The signatures
 * come from CREATE_ONLY_VERIFIED_CREATE_SIGNATURES, which the global Create Only
 * guard also uses, so the outer allowlist and the per-route guards cannot drift.
 * Each per-route guard refuses every request shape that could touch an existing
 * record, post an unintended balance, or reach another company.
 *
 * Guards only ever refuse; they never widen what the handler itself allows.
 * Legacy roles are unaffected because requireVerifiedBusinessAction passes
 * every non-Create-Only role straight through.
 */
import type { Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { customers, locations } from "@shared/schema";
import type { AccessControlResource } from "@shared/accessControlV2";
import { db } from "../../db";
import { getTrustedClientDate } from "../../lib/dateUtils";
import { requireVerifiedBusinessAction } from "./accessControlV2Enforcement";
import { storage } from "../../storage";
import { buildPermissionMap, canAccessPage } from "../../lib/permissionHelpers";
import { CREATE_ONLY_VERIFIED_CREATE_SIGNATURES, type CreateOnlyVerifiedCreateName } from "./createOnlyWritePolicy";
import { createOnlyRequestRules, isNonZeroAmount, isPresent, requestBody } from "./createOnlyRequestRules";

const body = (req: Request) => requestBody(req.body);

async function belongsToCompany(
  table: typeof customers | typeof locations,
  id: unknown,
  companyId: number
): Promise<boolean> {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return false;
  const where =
    table === customers
      ? and(eq(customers.id, numericId), eq(customers.companyId, companyId), isNull(customers.deletedAt))
      : and(eq(locations.id, numericId), eq(locations.companyId, companyId));
  const rows = await db.select({ id: table.id }).from(table).where(where).limit(1);
  return rows.length === 1;
}

function factoryCompanyId(req: Request): number | null {
  const value = Number(req.session?.factoryCompanyId || req.session?.currentCompanyId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

interface VerifiedCreateGuard {
  resource: AccessControlResource;
  /**
   * Legacy ERP page key that must stay enabled for Create Only in this company.
   * An administrator who switches the page off for the role also removes the
   * ability to create on it, so "permitted records" follows company settings.
   */
  legacyPageKey?: string;
  hardDenied: (req: Request) => boolean | Promise<boolean>;
}

async function createOnlyPageDisabled(req: Request, pageKey: string): Promise<boolean> {
  const companyId = Number(req.session?.currentCompanyId);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) return true;
  const permissions = await storage.getRoleFeaturePermissions(companyId);
  return !canAccessPage("Create Only", pageKey, buildPermissionMap(permissions, "Create Only"));
}

const VERIFIED_CREATE_GUARDS: Record<CreateOnlyVerifiedCreateName, VerifiedCreateGuard> = {
  suppliers: {
    resource: "erp.suppliers",
    legacyPageKey: "page_suppliers",
    hardDenied: (req) => isNonZeroAmount(body(req).openingBalance),
  },
  customers: {
    resource: "erp.customers",
    legacyPageKey: "page_customers",
    hardDenied: (req) => createOnlyRequestRules.customer(body(req)),
  },
  stockItems: {
    resource: "erp.stock_items",
    legacyPageKey: "page_stock_items",
    hardDenied: (req) => createOnlyRequestRules.stockItem(body(req)),
  },
  factoryBaleBatch: {
    resource: "factory.bales",
    hardDenied: (req) => createOnlyRequestRules.baleBatch(body(req)),
  },
  factoryCustomerOrders: {
    resource: "factory.customer_orders",
    hardDenied: async (req) => {
      const b = body(req);
      if (createOnlyRequestRules.customerOrderFields(b)) return true;
      const companyId = factoryCompanyId(req);
      if (!companyId) return true;
      if (!(await belongsToCompany(customers, b.customerId, companyId))) return true;
      if (isPresent(b.locationId) && !(await belongsToCompany(locations, b.locationId, companyId))) return true;
      return false;
    },
  },
  rentalUnits: {
    resource: "properties.units",
    hardDenied: (req) => createOnlyRequestRules.rentalUnit(body(req)),
  },
  rentalContracts: {
    resource: "properties.contracts",
    hardDenied: (req) => createOnlyRequestRules.rentalContract(body(req), getTrustedClientDate(req)),
  },
  retailProducts: {
    resource: "retail.stock_items",
    hardDenied: (req) => createOnlyRequestRules.retailProduct(body(req)),
  },
  spSales: {
    resource: "erp.sales",
    hardDenied: (req) => createOnlyRequestRules.spSale(body(req), getTrustedClientDate(req)),
  },
};

/** Exact "METHOD /path" signatures of one verified create, for route registration checks. */
export function createOnlyVerifiedSignatures(name: CreateOnlyVerifiedCreateName): readonly string[] {
  return CREATE_ONLY_VERIFIED_CREATE_SIGNATURES[name];
}

/** Per-route guard for one verified create. Install after requireAuth. */
export const CREATE_ONLY_VERIFIED_CREATE_GUARD_NAME = "createOnlyVerifiedCreate";

export function requireCreateOnlyVerifiedCreate(name: CreateOnlyVerifiedCreateName) {
  const entry = VERIFIED_CREATE_GUARDS[name];
  const guard = requireVerifiedBusinessAction({
    resource: entry.resource,
    action: "create",
    handlerVerified: true,
    hardDenied: async (req) => {
      if (await entry.hardDenied(req)) return true;
      return entry.legacyPageKey ? createOnlyPageDisabled(req, entry.legacyPageKey) : false;
    },
  });
  // A stable name makes the guard visible in config/route-manifest.json, so the
  // release tests can prove every allowlisted signature really carries it.
  Object.defineProperty(guard, "name", { value: CREATE_ONLY_VERIFIED_CREATE_GUARD_NAME });
  return guard;
}
