// Extracted from ./spGoldenCoastContainerOffloadRoutes.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { ledgerAccounts, spContainerLines, spContainers, voucherEntries } from "@shared/schema";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import { sumMoney, toMoney } from "../../lib/money";
import {
  GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER,
  GOLDEN_COAST_PHASE8_SOURCE_TYPE,
  type GoldenCoastPhase8ContainerOrigin,
  type GoldenCoastPhase8FundedContainerState,
  type GoldenCoastPhase8PostingAccount,
  type GoldenCoastPhase8RoleAccounts,
} from "../../services/accounting/goldenCoastContainerOffload";
import { requireSpCompany } from "./spHelpers";
import { FRESH_START_OTW_SOURCE_NAME } from "@shared/goldenCoastOtwSource";
import { GoldenCoastPhase8RouteError } from "./spGoldenCoastRouteSupport";
import {
  assertPhase8Ready,
  validateFundingAccount,
  validateStockItems,
  type DatabaseTransaction,
} from "./spGoldenCoastContainerOffloadRoutesValidateFundingAccount";

export async function loadFundedContainer(
  tx: DatabaseTransaction,
  companyId: number,
  containerId: number,
  accounts: GoldenCoastPhase8RoleAccounts
): Promise<GoldenCoastPhase8FundedContainerState> {
  const [container] = await tx
    .select()
    .from(spContainers)
    .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)))
    .limit(1)
    .for("update");
  if (!container) {
    throw new GoldenCoastPhase8RouteError(
      "Container was not found in this company",
      "GC_PHASE8_CONTAINER_NOT_FOUND",
      404
    );
  }
  if (!container.goodsOtwVoucherId) {
    throw new GoldenCoastPhase8RouteError(
      "Container does not have a Phase 8 funding voucher",
      "GC_PHASE8_CONTAINER_NOT_FUNDED",
      409
    );
  }
  if (container.status === "cancelled") {
    throw new GoldenCoastPhase8RouteError(
      "Cancelled containers cannot be offloaded",
      "GC_PHASE8_CONTAINER_CLOSED",
      409
    );
  }

  // A container reaches Phase 8 by one of two routes. Either this phase funded
  // it (an accounting_posting_requests marker ending ":fund"), or the migration
  // carried it across the cutover and linked a migration-owned `GC-OTW-*`
  // voucher. Phase 4 retires the legacy offload route for Golden Coast
  // companies, so rejecting the second kind would leave those containers with
  // no offload path at all.
  const markerResult = await tx.execute(sql`
    SELECT source_id
    FROM accounting_posting_requests
    WHERE company_id = ${companyId}
      AND voucher_id = ${container.goodsOtwVoucherId}
      AND source_type = ${GOLDEN_COAST_PHASE8_SOURCE_TYPE}
    ORDER BY id
  `);
  const markers = resultRows(markerResult);
  let origin: GoldenCoastPhase8ContainerOrigin;
  if (
    markers.length === 1 &&
    String(markers[0].source_id ?? "").endsWith(`:${GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER}`)
  ) {
    origin = "fresh_start_excel";
  } else if (markers.length === 1 && String(markers[0].source_id ?? "").endsWith(":fund")) {
    origin = "phase8";
  } else if (markers.length > 0) {
    throw new GoldenCoastPhase8RouteError(
      "Container funding voucher is not an unambiguous Golden Coast Phase 8 funding posting",
      "GC_PHASE8_CONTAINER_NOT_FUNDED",
      409
    );
  } else {
    const cutoverVoucher = await tx.execute(sql`
      SELECT id
      FROM vouchers
      WHERE id = ${container.goodsOtwVoucherId}
        AND company_id = ${companyId}
        AND source_module = 'SP_MIGRATION'
        AND voucher_number LIKE ${`GC-OTW-${companyId}-%`}
        AND deleted_at IS NULL
      LIMIT 1
    `);
    if (!resultRows(cutoverVoucher)[0]) {
      throw new GoldenCoastPhase8RouteError(
        "Container is neither Phase 8 funded nor linked to a migration-owned cutover Goods OTW voucher",
        "GC_PHASE8_CONTAINER_NOT_FUNDED",
        409
      );
    }
    origin = "cutover";
  }

  const entries = await tx
    .select()
    .from(voucherEntries)
    .where(eq(voucherEntries.voucherId, container.goodsOtwVoucherId));
  const stockEntry = entries.filter(
    (entry) => Number(entry.ledgerAccountId) === accounts.stockOtwAccountId && toMoney(entry.debitAmount).greaterThan(0)
  );
  const reserveEntry = entries.filter(
    (entry) =>
      Number(entry.ledgerAccountId) === accounts.containerReserveAccountId && toMoney(entry.debitAmount).greaterThan(0)
  );
  const creditEntries = entries.filter((entry) => toMoney(entry.creditAmount).greaterThan(0));
  if (stockEntry.length !== 1 || reserveEntry.length > 1 || creditEntries.length !== 1) {
    throw new GoldenCoastPhase8RouteError(
      origin === "cutover"
        ? "Cutover Goods OTW voucher no longer has the expected single Stock OTW debit and single clearing credit"
        : "Phase 8 funding voucher no longer has the expected Stock OTW / Container Reserve / funding shape",
      "GC_PHASE8_FUNDING_CORRUPT",
      409
    );
  }
  if ((origin === "cutover" || origin === "fresh_start_excel") && reserveEntry.length > 0) {
    throw new GoldenCoastPhase8RouteError(
      "A migration cutover container cannot carry a Phase 8 container reserve",
      "GC_PHASE8_FUNDING_CORRUPT",
      409
    );
  }
  const credit = creditEntries[0];
  const fundingAccount: GoldenCoastPhase8PostingAccount = credit.bankAccountId
    ? { kind: "bank", id: Number(credit.bankAccountId) }
    : credit.ledgerAccountId
      ? { kind: "ledger", id: Number(credit.ledgerAccountId) }
      : (() => {
          throw new GoldenCoastPhase8RouteError(
            "Phase 8 funding credit has no bank/ledger target",
            "GC_PHASE8_FUNDING_CORRUPT",
            409
          );
        })();
  // The cutover credit is the migration's OTW clearing account, not a Cash/Bank
  // funding account, so it must not be run through the funding-account check.
  // Nothing debits it back either: a cutover container has no reserve to return.
  if (origin === "phase8") {
    await validateFundingAccount(tx, companyId, fundingAccount);
  } else if (origin === "fresh_start_excel") {
    const clearingRows = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.subType, "sp_otw_clearing"),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt)
        )
      )
      .limit(2);
    if (clearingRows.length !== 1 || fundingAccount.kind !== "ledger" || fundingAccount.id !== clearingRows[0].id) {
      throw new GoldenCoastPhase8RouteError(
        "Fresh Start invoice funding must credit exactly this company's Goods OTW Clearing",
        "GC_PHASE8_FUNDING_CORRUPT",
        409
      );
    }
    if (container.supplierId != null || container.supplierName !== FRESH_START_OTW_SOURCE_NAME) {
      throw new GoldenCoastPhase8RouteError(
        "Fresh Start invoice has an unexpected supplier link",
        "GC_PHASE8_FUNDING_CORRUPT",
        409
      );
    }
    if (toMoney(container.invoiceTotalUsd).minus(toMoney(stockEntry[0].debitAmount)).abs().greaterThan("0.005")) {
      throw new GoldenCoastPhase8RouteError(
        "Fresh Start invoice total differs from Goods OTW voucher",
        "GC_PHASE8_FUNDING_CORRUPT",
        409
      );
    }
  }

  // Phase 22 (C), PE13: exact Decimal checks (were float arithmetic).
  const goodsCostUsd = toMoney(stockEntry[0].debitAmount).toFixed(2);
  const reserveUsd = reserveEntry.length === 1 ? toMoney(reserveEntry[0].debitAmount).toFixed(2) : "0.00";
  const expectedCredit = toMoney(goodsCostUsd).plus(reserveUsd);
  if (toMoney(credit.creditAmount).minus(expectedCredit).abs().greaterThan("0.005")) {
    throw new GoldenCoastPhase8RouteError(
      "Phase 8 funding voucher is not balanced to its funded assets",
      "GC_PHASE8_FUNDING_CORRUPT",
      409
    );
  }

  const lineRows = await tx
    .select()
    .from(spContainerLines)
    .where(and(eq(spContainerLines.containerId, containerId), eq(spContainerLines.companyId, companyId)))
    .orderBy(asc(spContainerLines.id));
  if (lineRows.length === 0) {
    throw new GoldenCoastPhase8RouteError("Funded container has no lines", "GC_PHASE8_FUNDING_CORRUPT", 409);
  }
  const lines = lineRows.map((line) => ({
    stockItemId: Number(line.stockItemId),
    articleCode: String(line.articleCode),
    description: line.description == null ? null : String(line.description),
    qty: String(line.qty),
    unitRateUsd: String(line.unitRateUsd),
  }));
  await validateStockItems(
    tx,
    companyId,
    lines.map((line) => line.stockItemId)
  );
  const lineValue = sumMoney(lines.map((line) => toMoney(line.qty).times(toMoney(line.unitRateUsd))));
  if (origin !== "fresh_start_excel" && lineValue.minus(goodsCostUsd).abs().greaterThan("0.01")) {
    throw new GoldenCoastPhase8RouteError(
      "Container lines no longer reconcile to the funded Stock OTW amount",
      "GC_PHASE8_FUNDING_CORRUPT",
      409
    );
  }

  return {
    containerId,
    companyId,
    origin,
    fundingVoucherId: Number(container.goodsOtwVoucherId),
    goodsCostUsd,
    reserveUsd,
    fundingAccount,
    lines,
  };
}

export async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const blockers: string[] = [];
    try {
      await assertPhase8Ready(db, companyId);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
    const openResult = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM sp_containers
      WHERE company_id = ${companyId} AND status = 'open'
    `);
    res.json({
      phase: 8,
      openContainers: Number(resultRows(openResult)[0]?.count ?? 0),
      blockers,
      canPost: blockers.length === 0,
    });
  } catch (error) {
    logger.error("Golden Coast Phase 8 readiness failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
