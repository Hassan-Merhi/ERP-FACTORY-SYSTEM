// Extracted from ./ensureCurrentInventoryLots.ts
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { spStockMovements, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { type GoldenCoastAccountRole } from "../../services/accounting/goldenCoastPhase2Accounts";
import {
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  type GoldenCoastFifoLot,
  type GoldenCoastPhase5RoleAccounts,
} from "../../services/accounting/goldenCoastPhase5PosSale";

export const PHASE6_MAX_SALE_LINES = 50;

export const PHASE6_READINESS_PATH = "/api/sp/golden-coast/phase6/pos-sale/readiness";

export const PHASE6_SALE_PATH = "/api/sp/golden-coast/phase6/pos-sale";

export const SALES_REVENUE_SUBTYPE = "sp_sales";

export const COGS_SUBTYPE = "sp_cogs";

export const PHASE6_REQUIRED_ROLES = [
  "gc_sales_cash",
  "stock_in_hand",
  "hassan_savings",
] as const satisfies readonly GoldenCoastAccountRole[];

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DbLike = typeof db | DatabaseTransaction;

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export type Phase6ResolvedAccounts = GoldenCoastPhase5RoleAccounts & {
  saleSideAccountName: string;
  gcSalesCashAccountId: number;
  hassanSavingsAccountId: number;
};

export async function lockFifoLots(
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
