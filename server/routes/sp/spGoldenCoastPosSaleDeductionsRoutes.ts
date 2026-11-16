import type { Request, Response } from "express";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  accountingPostingRequests,
  companies,
  ledgerAccounts,
  locations,
  inventory,
  stockItems,
  spStockMovements,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import {
  PostingValidationError,
  postBalancedVoucherTx,
  type CentralPostingResult,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "../../services/accounting/goldenCoastAccounts";
import {
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  GOLDEN_COAST_CURRENT_INVENTORY_FIFO_SOURCE,
  GoldenCoastPhase5SaleError,
  buildGoldenCoastPhase5SalePostings,
  goldenCoastPhase5IdempotencyKey,
  goldenCoastPhase5SaleDigest,
  goldenCoastPhase5SourceId,
  parseGoldenCoastPhase5SaleInput,
  planGoldenCoastPhase5Sale,
  type GoldenCoastFifoLot,
  type GoldenCoastPhase5PostingRole,
  type GoldenCoastPhase5RoleAccounts,
  type GoldenCoastPhase5SaleInput,
  type GoldenCoastPhase5SalePlan,
} from "../../services/accounting/goldenCoastPosSale";
import {
  GoldenCoastPhase6DeductionError,
  buildGoldenCoastPhase6SpecialLocationDeductionPosting,
  goldenCoastPhase6IdempotencyKey,
  goldenCoastPhase6SourceId,
  planGoldenCoastPhase6SpecialLocationDeduction,
  type GoldenCoastPhase6DeductionPlan,
} from "../../services/accounting/goldenCoastSpecialLocationDeduction";
import { GoldenCoastPhase7TransferError } from "../../services/accounting/goldenCoastHadiTransfer";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import { GOLDEN_COAST_CUTOVER_DATE } from "../../services/accounting/goldenCoastCutoverFifo";
import {
  GoldenCoastPhase6AutoHadiError,
  postGoldenCoastAutomaticHadiCollectionTx,
  resolveGoldenCoastAutomaticHadiPair,
} from "./goldenCoastAutoHadi";
import { isGoldenCoastCompany } from "./spGoldenCoastCutoverFifoRoutes";
import { loadGoldenCoastAccounts } from "./spGoldenCoastSetupRoutes";
import { requireSpCompany } from "./spHelpers";

const postingDependencies = createDatabasePostingDependencies();
export const phase6RequestBudget = privilegedRequestBudget({ maxBodyBytes: 32 * 1024, maxCollectionItems: 50 });
const PHASE6_MAX_SALE_LINES = 50;
export const PHASE6_READINESS_PATH = "/api/sp/golden-coast/phase6/pos-sale/readiness";
export const PHASE6_SALE_PATH = "/api/sp/golden-coast/phase6/pos-sale";
const SALES_REVENUE_SUBTYPE = "sp_sales";
const COGS_SUBTYPE = "sp_cogs";
const PHASE6_REQUIRED_ROLES = [
  "gc_sales_cash",
  "stock_in_hand",
  "hassan_savings",
] as const satisfies readonly GoldenCoastAccountRole[];

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DatabaseTransaction;
type PersistedPostingResult = CentralPostingResult<typeof vouchers.$inferSelect, typeof voucherEntries.$inferSelect>;

type Phase6ResolvedAccounts = GoldenCoastPhase5RoleAccounts & {
  saleSideAccountName: string;
  gcSalesCashAccountId: number;
  hassanSavingsAccountId: number;
};

class GoldenCoastPhase6RouteError extends Error {
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

async function resolvePhase6Accounts(conn: DbLike, companyId: number): Promise<Phase6ResolvedAccounts> {
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

async function countGoldenCoastFifoLots(conn: DbLike, companyId: number): Promise<number> {
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

async function ensureCurrentInventoryLots(
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

async function resolveSpecialLocationConfig(
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

async function lockFifoLots(
  tx: DatabaseTransaction,
  companyId: number,
  locationId: number,
  stockItemIds: readonly number[]
): Promise<GoldenCoastFifoLot[]> {
  const rows = await tx
    .select({
      id: spStockMovements.id,
      companyId: spStockMovements.companyId,
      locationId: spStockMovements.locationId,
      stockItemId: spStockMovements.stockItemId,
      articleCode: spStockMovements.articleCode,
      description: spStockMovements.description,
      sourceType: spStockMovements.sourceType,
      qtyRemaining: spStockMovements.qtyRemaining,
      finalUnitCostUsd: spStockMovements.finalUnitCostUsd,
      createdAt: spStockMovements.createdAt,
    })
    .from(spStockMovements)
    .where(
      and(
        eq(spStockMovements.companyId, companyId),
        eq(spStockMovements.locationId, locationId),
        inArray(spStockMovements.stockItemId, [...stockItemIds]),
        inArray(spStockMovements.sourceType, [...GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES]),
        sql`CAST(${spStockMovements.qtyRemaining} AS numeric) > 0`
      )
    )
    .orderBy(asc(spStockMovements.createdAt), asc(spStockMovements.id))
    .for("update");

  return rows.map((row) => ({
    id: Number(row.id),
    companyId: Number(row.companyId),
    locationId: row.locationId == null ? null : Number(row.locationId),
    stockItemId: row.stockItemId == null ? null : Number(row.stockItemId),
    articleCode: String(row.articleCode ?? ""),
    description: row.description == null ? null : String(row.description),
    sourceType: row.sourceType == null ? null : String(row.sourceType),
    qtyRemaining: String(row.qtyRemaining ?? "0"),
    finalUnitCostUsd: String(row.finalUnitCostUsd ?? "0"),
    createdAt: row.createdAt == null ? null : new Date(row.createdAt).toISOString(),
  }));
}

async function consumeFifoLot(
  tx: DatabaseTransaction,
  companyId: number,
  allocation: { lotId: number; qty: string; qtyRemainingAfter: string }
): Promise<void> {
  const updated = await tx.execute(sql`
    UPDATE sp_stock_movements
    SET qty_remaining = ${allocation.qtyRemainingAfter}
    WHERE id = ${allocation.lotId}
      AND company_id = ${companyId}
      AND CAST(qty_remaining AS numeric) >= CAST(${allocation.qty} AS numeric)
    RETURNING id
  `);
  if (resultRows(updated).length !== 1) {
    throw new GoldenCoastPhase6RouteError(
      `Golden Coast FIFO lot #${allocation.lotId} changed while the sale was being posted`,
      "GC_PHASE6_FIFO_CONFLICT",
      409
    );
  }
}

async function findPostedVoucher(
  tx: DatabaseTransaction,
  companyId: number,
  idempotencyKey: string
): Promise<{ voucher: typeof vouchers.$inferSelect; sourceId: string } | null> {
  const [marker] = await tx
    .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId)))
    .limit(1);
  if (!voucher) {
    throw new GoldenCoastPhase6RouteError(
      `Golden Coast sale idempotency marker ${idempotencyKey} references a missing voucher`,
      "GC_PHASE6_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, sourceId: String(marker.sourceId ?? "") };
}

async function loadVoucherEntries(tx: DatabaseTransaction, voucherId: number) {
  return tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}

function saleRevenueUsd(sale: GoldenCoastPhase5SaleInput): string {
  return sale.lines
    .reduce(
      (sum, line) => sum.plus(new Decimal(line.qty).times(new Decimal(line.unitPriceUsd)).toDecimalPlaces(2)),
      new Decimal(0)
    )
    .toDecimalPlaces(2)
    .toFixed(2);
}

function preDeductionPlan(sale: GoldenCoastPhase5SaleInput, rate: string): GoldenCoastPhase6DeductionPlan | null {
  const totalQty = sale.lines.reduce((sum, line) => sum.plus(new Decimal(line.qty)), new Decimal(0));
  const revenueUsd = saleRevenueUsd(sale);
  const pseudoPlan: GoldenCoastPhase5SalePlan = {
    companyId: sale.companyId,
    locationId: sale.locationId,
    saleDate: sale.saleDate,
    customerName: sale.customerName,
    clientRequestId: sale.clientRequestId,
    revenueUsd,
    cogsUsd: "0.00",
    grossProfitUsd: revenueUsd,
    totalQty: totalQty.toDecimalPlaces(4).toFixed(4),
    lines: [],
    allocations: [],
  };
  return planGoldenCoastPhase6SpecialLocationDeduction({ salePlan: pseudoPlan, deductionPerQtyUsd: rate });
}

async function findReplayedSale(input: {
  tx: DatabaseTransaction;
  companyId: number;
  sale: GoldenCoastPhase5SaleInput;
  saleDigest: string;
  deductionPlan: GoldenCoastPhase6DeductionPlan | null;
}) {
  const roles: GoldenCoastPhase5PostingRole[] = ["revenue", "cogs"];
  const phase5 = await Promise.all(
    roles.map(async (role) => ({
      role,
      marker: await findPostedVoucher(
        input.tx,
        input.companyId,
        goldenCoastPhase5IdempotencyKey(input.companyId, input.sale.clientRequestId, role)
      ),
    }))
  );
  const deductionMarker = await findPostedVoucher(
    input.tx,
    input.companyId,
    goldenCoastPhase6IdempotencyKey(input.companyId, input.sale.clientRequestId)
  );
  const phase5Posted = phase5.filter((item) => item.marker != null);
  const anyPosted = phase5Posted.length > 0 || deductionMarker != null;
  if (!anyPosted) return null;
  if (phase5Posted.length !== roles.length) {
    throw new GoldenCoastPhase6RouteError(
      `Golden Coast sale ${input.sale.clientRequestId} has a partially recorded revenue/COGS pair`,
      "GC_PHASE6_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  for (const item of phase5) {
    const expected = goldenCoastPhase5SourceId(input.sale.clientRequestId, input.saleDigest, item.role);
    if (item.marker?.sourceId !== expected) {
      throw new GoldenCoastPhase6RouteError(
        `Golden Coast sale ${input.sale.clientRequestId} was already posted with different sale data`,
        "GC_PHASE6_IDEMPOTENCY_CONFLICT",
        409
      );
    }
  }

  if (input.deductionPlan) {
    if (!deductionMarker) {
      throw new GoldenCoastPhase6RouteError(
        `Golden Coast sale ${input.sale.clientRequestId} is missing its required special-location deduction posting`,
        "GC_PHASE6_IDEMPOTENCY_INCONSISTENT",
        409
      );
    }
    const expected = goldenCoastPhase6SourceId({
      requestId: input.sale.clientRequestId,
      saleDigest: input.saleDigest,
      deductionPerQtyUsd: input.deductionPlan.deductionPerQtyUsd,
      deductionUsd: input.deductionPlan.deductionUsd,
    });
    if (deductionMarker.sourceId !== expected) {
      throw new GoldenCoastPhase6RouteError(
        `Golden Coast sale ${input.sale.clientRequestId} was already posted under a different special-location deduction configuration`,
        "GC_PHASE6_IDEMPOTENCY_CONFLICT",
        409
      );
    }
  } else if (deductionMarker) {
    throw new GoldenCoastPhase6RouteError(
      `Golden Coast sale ${input.sale.clientRequestId} already has a special-location deduction but the current configuration no longer matches`,
      "GC_PHASE6_IDEMPOTENCY_CONFLICT",
      409
    );
  }

  const postings = await Promise.all(
    phase5.map(async (item) => {
      const voucher = item.marker!.voucher;
      return { role: item.role as string, voucher, entries: await loadVoucherEntries(input.tx, voucher.id) };
    })
  );
  if (deductionMarker) {
    postings.push({
      role: "special_deduction",
      voucher: deductionMarker.voucher,
      entries: await loadVoucherEntries(input.tx, deductionMarker.voucher.id),
    });
  }
  return postings;
}

export async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE6_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const blockers: string[] = [];
    // Keep the legacy FIFO diagnostic in the response for setup screens and
    // compatibility tests, but do not make the retired cutover bridge block
    // the normal itemized POS flow. Required accounting roles still block
    // readiness because the sale cannot post without them.
    let accounts: Phase6ResolvedAccounts | null = null;
    let automaticHadiPair: Awaited<ReturnType<typeof resolveGoldenCoastAutomaticHadiPair>> | null = null;
    let costLotCount = 0;
    try {
      accounts = await resolvePhase6Accounts(db, companyId);
    } catch (error) {
      logger.warn("Golden Coast legacy Phase 6 diagnostics unavailable", { error });
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    try {
      automaticHadiPair = await resolveGoldenCoastAutomaticHadiPair(db, companyId);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    try {
      costLotCount = await countGoldenCoastFifoLots(db, companyId);
    } catch (error) {
      logger.warn("Golden Coast legacy FIFO diagnostic unavailable", { error });
    }
    const configured = await db
      .select({
        id: locations.id,
        name: locations.name,
        deductionPerQtyUsd: locations.supplierPartnerPayableDeductionPerQty,
      })
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
      .limit(3);
    if (configured.length > 1)
      blockers.push("More than one active location has a Golden Coast per-unit deduction configured");
    const [company] = await db
      .select({ parentCompanyId: companies.parentCompanyId, active: companies.active })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    res.json({
      costLotCount,
      accounts,
      parentCompanyId: company?.parentCompanyId ?? null,
      automaticHadiPair,
      specialLocation: configured.length === 1 ? configured[0] : null,
      blockers,
      canPost: blockers.length === 0,
    });
  } catch (error) {
    logger.error("Golden Coast Phase 6 readiness failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export async function handlePostSale(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  const userId = req.session.userId;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;
    if (!(await isGoldenCoastCompany(db, selectedCompany))) {
      res.status(409).json({
        code: "GC_PHASE6_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const sale = parseGoldenCoastPhase5SaleInput({
      companyId: selectedCompany,
      body: req.body,
      maxLines: PHASE6_MAX_SALE_LINES,
    });
    const exchangeRate = await getCurrentExchangeRate(selectedCompany);
    const revenueUsd = saleRevenueUsd(sale);
    const actor = {
      userId: userId ?? null,
      username: req.session.username || "unknown",
      reason: "Golden Coast Phase 6 POS sale with automatic HADI collection",
    };

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase6-sale:${selectedCompany}:${sale.clientRequestId}`}))`
      );
      if (!(await isGoldenCoastCompany(tx, selectedCompany))) {
        throw new GoldenCoastPhase6RouteError(
          "Golden Coast account setup is not configured",
          "GC_PHASE6_NOT_CONFIGURED",
          409
        );
      }
      const specialConfig = await resolveSpecialLocationConfig(tx, selectedCompany, sale.locationId);
      const accounts = await resolvePhase6Accounts(tx, selectedCompany);
      if ((req.body as Record<string, unknown> | undefined)?.saleSideAccount != null) {
        throw new GoldenCoastPhase6RouteError(
          "saleSideAccount overrides are retired for Golden Coast",
          "GC_PHASE6_SALE_SIDE_OVERRIDE_RETIRED"
        );
      }
      const saleSideAccount = { kind: "ledger" as const, id: accounts.gcSalesCashAccountId };
      const saleDigest = goldenCoastPhase5SaleDigest({ sale, saleSideAccount });
      const expectedDeduction = preDeductionPlan(sale, specialConfig.deductionPerQtyUsd);
      const replayed = await findReplayedSale({
        tx,
        companyId: selectedCompany,
        sale,
        saleDigest,
        deductionPlan: expectedDeduction,
      });
      if (replayed) {
        const automaticHadiCollection =
          sale.saleDate >= GOLDEN_COAST_CUTOVER_DATE
            ? await postGoldenCoastAutomaticHadiCollectionTx({
                tx,
                companyId: selectedCompany,
                gcSalesCashAccountId: accounts.gcSalesCashAccountId,
                saleDate: sale.saleDate,
                amountUsd: revenueUsd,
                clientRequestId: sale.clientRequestId,
                actor,
              })
            : null;
        const postings = [
          ...replayed,
          ...(automaticHadiCollection
            ? automaticHadiCollection.postings.map((item) => ({
                role: `hadi_collection_${item.role}`,
                voucher: item.voucher,
                entries: item.entries,
              }))
            : []),
        ];
        return {
          replayed: true as const,
          postings,
          plan: null,
          deductionPlan: expectedDeduction,
          automaticHadiCollection,
        };
      }

      const stockItemIds = [...new Set(sale.lines.map((line) => line.stockItemId))];
      let lots = await lockFifoLots(tx, selectedCompany, sale.locationId, stockItemIds);
      await ensureCurrentInventoryLots(tx, selectedCompany, sale.locationId, stockItemIds, lots);
      lots = await lockFifoLots(tx, selectedCompany, sale.locationId, stockItemIds);
      const plan = planGoldenCoastPhase5Sale({ sale, lots });
      const deductionPlan = planGoldenCoastPhase6SpecialLocationDeduction({
        salePlan: plan,
        deductionPerQtyUsd: specialConfig.deductionPerQtyUsd,
      });

      for (const allocation of plan.allocations) {
        await consumeFifoLot(tx, selectedCompany, allocation);
        await adjustSpInventoryAtomic(tx, {
          companyId: selectedCompany,
          locationId: allocation.locationId,
          stockItemId: allocation.stockItemId,
          deltaQty: -Number(allocation.qty),
          context: `Golden Coast Phase 6 sale ${sale.clientRequestId} from FIFO lot #${allocation.lotId}`,
          sourceVoucherType: "GC_PHASE6_SALE",
        });
      }

      const batch = buildGoldenCoastPhase5SalePostings({
        plan,
        accounts,
        saleSideAccount,
        saleDigest,
        exchangeRate: exchangeRate != null ? String(exchangeRate) : null,
        actor,
      });

      const postings: Array<{
        role: string;
        voucher: PersistedPostingResult["voucher"];
        entries: PersistedPostingResult["entries"];
      }> = [];
      for (const item of batch.postings) {
        const posted = (await postBalancedVoucherTx(tx, item.request, postingDependencies)) as PersistedPostingResult;
        if (posted.replayed) {
          throw new GoldenCoastPhase6RouteError(
            `Golden Coast sale ${sale.clientRequestId} ${item.role} voucher was already posted`,
            "GC_PHASE6_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({ role: item.role, voucher: posted.voucher, entries: posted.entries });
      }

      if (deductionPlan) {
        const deductionRequest = buildGoldenCoastPhase6SpecialLocationDeductionPosting({
          plan: deductionPlan,
          gcSalesCashAccountId: accounts.gcSalesCashAccountId,
          hassanSavingsAccountId: accounts.hassanSavingsAccountId,
          saleDigest,
          exchangeRate: exchangeRate != null ? String(exchangeRate) : null,
          actor: {
            userId: userId ?? null,
            username: req.session.username || "unknown",
            reason: "Golden Coast special-location deduction",
          },
        });
        const posted = (await postBalancedVoucherTx(
          tx,
          deductionRequest,
          postingDependencies
        )) as PersistedPostingResult;
        if (posted.replayed) {
          throw new GoldenCoastPhase6RouteError(
            `Golden Coast sale ${sale.clientRequestId} special deduction was already posted`,
            "GC_PHASE6_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({ role: "special_deduction", voucher: posted.voucher, entries: posted.entries });
      }

      const automaticHadiCollection =
        sale.saleDate >= GOLDEN_COAST_CUTOVER_DATE
          ? await postGoldenCoastAutomaticHadiCollectionTx({
              tx,
              companyId: selectedCompany,
              gcSalesCashAccountId: accounts.gcSalesCashAccountId,
              saleDate: sale.saleDate,
              amountUsd: plan.revenueUsd,
              clientRequestId: sale.clientRequestId,
              actor,
            })
          : null;
      if (automaticHadiCollection) {
        postings.push(
          ...automaticHadiCollection.postings.map((item) => ({
            role: `hadi_collection_${item.role}`,
            voucher: item.voucher,
            entries: item.entries,
          }))
        );
      }

      return { replayed: false as const, postings, plan, deductionPlan, automaticHadiCollection };
    });

    logger.info("Golden Coast Phase 6 POS sale posted", {
      module: "golden-coast-phase6",
      companyId: selectedCompany,
      userId,
      clientRequestId: sale.clientRequestId,
      locationId: sale.locationId,
      replayed: result.replayed,
      voucherIds: result.postings.map((item) => item.voucher.id),
      deductionUsd: result.deductionPlan?.deductionUsd ?? "0.00",
      automaticHadiCompanyId: result.automaticHadiCollection?.pair.hadiCompanyId ?? null,
      automaticHadiCashAccount: result.automaticHadiCollection?.hadiCashAccount ?? null,
      automaticHadiReplayed: result.automaticHadiCollection?.replayed ?? false,
      durationMs: Date.now() - startedAt,
    });

    res.json({
      clientRequestId: sale.clientRequestId,
      locationId: sale.locationId,
      replayed: result.replayed,
      revenueUsd: result.plan?.revenueUsd ?? revenueUsd,
      cogsUsd: result.plan?.cogsUsd ?? null,
      grossProfitUsd: result.plan?.grossProfitUsd ?? null,
      specialLocationDeductionUsd: result.deductionPlan?.deductionUsd ?? "0.00",
      deductionPerQtyUsd: result.deductionPlan?.deductionPerQtyUsd ?? "0.0000",
      automaticHadiCollection: result.automaticHadiCollection
        ? {
            replayed: result.automaticHadiCollection.replayed,
            hadiCompanyId: result.automaticHadiCollection.pair.hadiCompanyId,
            amountUsd: result.automaticHadiCollection.transfer.amountUsd,
            hadiCashAccount: result.automaticHadiCollection.hadiCashAccount,
          }
        : null,
      lines: result.plan?.lines ?? null,
      allocations: result.plan?.allocations ?? null,
      postings: result.postings.map((item) => ({ role: item.role, voucher: item.voucher, entries: item.entries })),
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 6 POS sale failed", {
      module: "golden-coast-phase6",
      companyId,
      userId,
      durationMs: Date.now() - startedAt,
      error,
    });
    if (error instanceof GoldenCoastPhase6RouteError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase6AutoHadiError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase7TransferError) {
      const conflictCodes = new Set(["GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS", "GC_PHASE7_SCOPE_INVALID"]);
      res.status(conflictCodes.has(error.code) ? 409 : 400).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase6DeductionError) {
      res
        .status(error.code === "GC_PHASE6_DEDUCTION_INVALID" ? 400 : 409)
        .json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastPhase5SaleError) {
      const status = error.code === "GC_PHASE5_INPUT_INVALID" ? 400 : 409;
      res.status(status).json({ code: error.code, message: error.message });
      return;
    }
    if (respondToSpInventoryIntegrityError(res, error)) return;
    if (error instanceof PostingValidationError) {
      res
        .status(error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400)
        .json({ code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
