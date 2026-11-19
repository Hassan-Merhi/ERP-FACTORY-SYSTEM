// Extracted from ./spGoldenCoastPosSaleDeductionsRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, companies, locations, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import {
  goldenCoastPhase5IdempotencyKey,
  type GoldenCoastPhase5PostingRole,
  type GoldenCoastPhase5SaleInput,
  type GoldenCoastPhase5SalePlan,
  goldenCoastPhase5SourceId,
} from "../../services/accounting/goldenCoastPosSale";
import {
  type GoldenCoastPhase6DeductionPlan,
  goldenCoastPhase6IdempotencyKey,
  goldenCoastPhase6SourceId,
  planGoldenCoastPhase6SpecialLocationDeduction,
} from "../../services/accounting/goldenCoastSpecialLocationDeduction";
import { resolveGoldenCoastAutomaticHadiPair } from "./goldenCoastAutoHadi";
import { isGoldenCoastCompany } from "./spGoldenCoastCutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  GoldenCoastPhase6RouteError,
  countGoldenCoastFifoLots,
  resolvePhase6Accounts,
  type DatabaseTransaction,
  type Phase6ResolvedAccounts,
} from "./ensureCurrentInventoryLots";

export async function consumeFifoLot(
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

export function saleRevenueUsd(sale: GoldenCoastPhase5SaleInput): string {
  return sale.lines
    .reduce(
      (sum, line) => sum.plus(new Decimal(line.qty).times(new Decimal(line.unitPriceUsd)).toDecimalPlaces(2)),
      new Decimal(0)
    )
    .toDecimalPlaces(2)
    .toFixed(2);
}

export function preDeductionPlan(
  sale: GoldenCoastPhase5SaleInput,
  rate: string
): GoldenCoastPhase6DeductionPlan | null {
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

export async function findReplayedSale(input: {
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
