// Extracted from ./spGoldenCoastPhase6PosSaleRoutes.ts to keep that module under the source-size cap.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { inventory, ledgerAccounts, locations, spStockMovements, stockItems } from "@shared/schema";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { resultRows } from "../../lib/queryResult";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "../../services/accounting/goldenCoastPhase2Accounts";
import {
  GOLDEN_COAST_CURRENT_INVENTORY_FIFO_SOURCE,
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  type GoldenCoastFifoLot,
} from "../../services/accounting/goldenCoastPhase5PosSale";
import { loadGoldenCoastAccounts } from "./spGoldenCoastSetupRoutes";
import {
  SALES_REVENUE_SUBTYPE,
  COGS_SUBTYPE,
  PHASE6_REQUIRED_ROLES,
  type DatabaseTransaction,
  type DbLike,
  type Phase6ResolvedAccounts,
} from "./ensureCurrentInventoryLotsLockFifoLots";
export {
  PHASE6_MAX_SALE_LINES,
  PHASE6_READINESS_PATH,
  PHASE6_SALE_PATH,
  lockFifoLots,
  type DatabaseTransaction,
  type PersistedPostingResult,
  type Phase6ResolvedAccounts,
} from "./ensureCurrentInventoryLotsLockFifoLots";

export const postingDependencies = createDatabasePostingDependencies();

export const phase6RequestBudget = privilegedRequestBudget({ maxBodyBytes: 32 * 1024, maxCollectionItems: 50 });

export class GoldenCoastPhase6RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE6_SALE_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase6RouteError";
    this.code = code;
    this.status = status;
  }
}

function activeCanonicalRoleAccount(
  accounts: readonly GoldenCoastLedgerRow[],
  role: GoldenCoastAccountRole
): GoldenCoastLedgerRow {
  const definition = getGoldenCoastAccountDefinition(role);
  const matches = accounts.filter(
    (account) => account.subType === definition.subType && account.active === true && account.deletedAt == null
  );
  if (matches.length !== 1) {
    throw new GoldenCoastPhase6RouteError(
      matches.length === 0
        ? `Golden Coast role ${role} is missing; run Golden Coast account setup first`
        : `Golden Coast role ${role} is ambiguous (${matches.length} active accounts share ${definition.subType})`,
      "GC_PHASE6_ROLES_INVALID",
      409
    );
  }
  const account = matches[0];
  if (!definition.acceptedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase6RouteError(
      `Golden Coast role ${role} must use account type ${definition.acceptedAccountTypes.join(" or ")}; account "${account.name}" is ${account.accountType}`,
      "GC_PHASE6_ROLES_INVALID",
      409
    );
  }
  return account;
}

async function activeSubTypeAccount(
  conn: DbLike,
  companyId: number,
  subType: string,
  expectedAccountTypes: readonly string[]
): Promise<{ id: number; name: string; accountType: string }> {
  const rows = await conn
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);
  if (rows.length !== 1) {
    throw new GoldenCoastPhase6RouteError(
      rows.length === 0
        ? `Golden Coast accounting role ${subType} is not configured for this company`
        : `Golden Coast accounting role ${subType} is ambiguous; repair duplicate canonical accounts first`,
      "GC_PHASE6_ROLES_INVALID",
      409
    );
  }
  const account = { id: Number(rows[0].id), name: rows[0].name, accountType: String(rows[0].accountType) };
  if (!expectedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase6RouteError(
      `Golden Coast accounting role ${subType} must be one of ${expectedAccountTypes.join(", ")}; account "${account.name}" is ${account.accountType}`,
      "GC_PHASE6_ROLES_INVALID",
      409
    );
  }
  return account;
}

export async function resolvePhase6Accounts(conn: DbLike, companyId: number): Promise<Phase6ResolvedAccounts> {
  const goldenCoastAccounts = await loadGoldenCoastAccounts(conn, companyId);
  for (const role of PHASE6_REQUIRED_ROLES) activeCanonicalRoleAccount(goldenCoastAccounts, role);
  const saleSide = activeCanonicalRoleAccount(goldenCoastAccounts, "gc_sales_cash");
  const stockInHand = activeCanonicalRoleAccount(goldenCoastAccounts, "stock_in_hand");
  const hassanSavings = activeCanonicalRoleAccount(goldenCoastAccounts, "hassan_savings");
  const [salesRevenue, cogs] = await Promise.all([
    activeSubTypeAccount(conn, companyId, SALES_REVENUE_SUBTYPE, ["Income", "Direct Income"]),
    activeSubTypeAccount(conn, companyId, COGS_SUBTYPE, ["Direct Expense", "Expense"]),
  ]);
  return {
    saleSideAccountId: saleSide.id,
    saleSideAccountName: saleSide.name,
    salesRevenueAccountId: salesRevenue.id,
    cogsAccountId: cogs.id,
    stockInHandAccountId: stockInHand.id,
    gcSalesCashAccountId: saleSide.id,
    hassanSavingsAccountId: hassanSavings.id,
  };
}

export async function countGoldenCoastFifoLots(conn: DbLike, companyId: number): Promise<number> {
  const rows = await conn.execute(sql`
    SELECT COUNT(*)::int AS lot_count
    FROM sp_stock_movements
    WHERE company_id = ${companyId}
      AND source_type IN (${sql.join(
        GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES.map((source) => sql`${source}`),
        sql`, `
      )})
  `);
  return Number(resultRows(rows)[0]?.lot_count ?? 0);
}

export async function ensureCurrentInventoryLots(
  tx: DatabaseTransaction,
  companyId: number,
  locationId: number,
  stockItemIds: readonly number[],
  existingLots: readonly GoldenCoastFifoLot[]
): Promise<void> {
  const covered = new Set(existingLots.map((lot) => Number(lot.stockItemId)).filter((id) => Number.isInteger(id)));
  const missing = stockItemIds.filter((stockItemId) => !covered.has(stockItemId));
  if (missing.length === 0) return;

  const rows = await tx
    .select({
      inventoryId: inventory.id,
      stockItemId: inventory.stockItemId,
      quantity: inventory.quantity,
      averageRate: inventory.averageRate,
      articleCode: stockItems.code,
      description: stockItems.name,
    })
    .from(inventory)
    .innerJoin(stockItems, eq(stockItems.id, inventory.stockItemId))
    .where(
      and(
        eq(inventory.companyId, companyId),
        eq(inventory.locationId, locationId),
        inArray(inventory.stockItemId, missing),
        sql`CAST(${inventory.quantity} AS numeric) > 0`
      )
    )
    .for("update");

  for (const row of rows) {
    const quantity = new Decimal(String(row.quantity ?? "0"));
    const rate = new Decimal(String(row.averageRate ?? "0"));
    if (rate.lte(0)) {
      throw new GoldenCoastPhase6RouteError(
        `Stock item #${row.stockItemId} has positive inventory with no usable average rate`,
        "GC_PHASE5_FIFO_COST_INVALID",
        409
      );
    }
    const unitCost = rate.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
    await tx.insert(spStockMovements).values({
      companyId,
      sourceType: GOLDEN_COAST_CURRENT_INVENTORY_FIFO_SOURCE,
      articleCode: String(row.articleCode ?? ""),
      description: `Golden Coast current inventory cost lot from inventory #${row.inventoryId}`,
      stockItemId: Number(row.stockItemId),
      locationId,
      qtyIn: quantity.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
      qtyRemaining: quantity.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
      baseUnitCostUsd: unitCost,
      landedUnitCostUsd: unitCost,
      finalUnitCostUsd: unitCost,
    });
  }
}

export async function resolveSpecialLocationConfig(
  conn: DbLike,
  companyId: number,
  saleLocationId: number
): Promise<{ deductionPerQtyUsd: string; specialLocationId: number | null }> {
  const [saleLocation] = await conn
    .select({
      id: locations.id,
      deduction: locations.supplierPartnerPayableDeductionPerQty,
    })
    .from(locations)
    .where(
      and(
        eq(locations.id, saleLocationId),
        eq(locations.companyId, companyId),
        eq(locations.active, true),
        isNull(locations.deletedAt)
      )
    )
    .limit(1);
  if (!saleLocation) {
    throw new GoldenCoastPhase6RouteError(
      `Location ${saleLocationId} is not an active location in this company`,
      "GC_PHASE6_LOCATION_INVALID",
      400
    );
  }

  const configured = await conn
    .select({ id: locations.id, deduction: locations.supplierPartnerPayableDeductionPerQty })
    .from(locations)
    .where(
      and(
        eq(locations.companyId, companyId),
        eq(locations.active, true),
        isNull(locations.deletedAt),
        sql`CAST(${locations.supplierPartnerPayableDeductionPerQty} AS numeric) > 0`
      )
    )
    .orderBy(asc(locations.id))
    .limit(2);

  if (configured.length > 1) {
    throw new GoldenCoastPhase6RouteError(
      "Golden Coast allows exactly one special deduction location; more than one active location has a positive deduction configured",
      "GC_PHASE6_SPECIAL_LOCATION_AMBIGUOUS",
      409
    );
  }

  const special = configured[0] ?? null;
  if (!special || Number(special.id) !== saleLocationId) {
    return { deductionPerQtyUsd: "0", specialLocationId: special ? Number(special.id) : null };
  }
  return { deductionPerQtyUsd: String(special.deduction ?? "0"), specialLocationId: Number(special.id) };
}
