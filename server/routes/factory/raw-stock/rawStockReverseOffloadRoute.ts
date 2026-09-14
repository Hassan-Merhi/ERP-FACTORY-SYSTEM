import Decimal from "decimal.js";
import type { Express } from "express";
import { eq, and, or, sql, inArray, ilike, isNull } from "drizzle-orm";

import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryContainerCommissions,
  voucherEntries,
  factoryDaybookEntries,
  factoryOffloadAdditionalCharges,
  vouchers,
  factoryContainerReceipts,
} from "@shared/schema";

import { db, type DbTransaction, type DatabaseOrTransaction } from "../../../db";
import { requireAuth } from "../../../auth";
import { logAudit } from "../../helpers/auditHelpers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import {
  getAuthoritativeSupplierRemainingKg,
  getLockedSupplierRate,
} from "../../../services/factory/rawStockLockedRate";
import {
  financialOperationErrorStatus,
  financialOperationRequestPayload,
  resolveOptionalFinancialOperationKey,
} from "../../../services/accounting/financialOperationRequest";
import {
  DurableFinancialOperationError,
  financialOperationFingerprint,
  withDurableFinancialOperation,
} from "../../../services/accounting/durableFinancialOperation";

const REVERSAL_STATUS_MESSAGE = "Only OFFLOADED or PARTIALLY_RECEIVED containers can be reversed";
const REVERSAL_SUCCESS_MESSAGE = "Offload reversed successfully. Container is back to its previous status.";

function isReversibleStatus(status: string | null | undefined): boolean {
  return status === "OFFLOADED" || status === "PARTIALLY_RECEIVED";
}

/** Carries the caller's status through the reversal so the error can be typed. */
class ReverseOffloadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ReverseOffloadError";
  }
}

type ReverseOffloadOutcome = { message: string; containerStatus: string | null };

function consumingMixBatchMessage(codes: string[]): string {
  return `Cannot reverse offload: stock from this container has already been consumed in mix batch(es) ${codes.join(", ")}. Remove it from those batches first before reversing.`;
}

/**
 * Batch codes that have already consumed this container's raw stock in
 * production. Run against the same executor as the reversal so the check inside
 * the transaction sees what the reversal is about to undo.
 */
async function findConsumingMixBatchCodes(
  executor: DatabaseOrTransaction,
  companyId: number,
  containerId: number
): Promise<string[]> {
  const mixSourceLinks = await executor
    .select({ mixBatchId: factoryMixBatchSources.mixBatchId })
    .from(factoryMixBatchSources)
    .where(eq(factoryMixBatchSources.containerId, containerId));

  if (mixSourceLinks.length === 0) return [];

  const linkedBatchIds = [...new Set(mixSourceLinks.map((link) => link.mixBatchId))];
  const usedBatches = await executor
    .select({ batchCode: factoryMixBatches.batchCode })
    .from(factoryMixBatches)
    .where(
      and(
        eq(factoryMixBatches.companyId, companyId),
        inArray(factoryMixBatches.id, linkedBatchIds),
        sql`${factoryMixBatches.usedKg}::numeric > 0`,
        // A soft-deleted batch no longer holds live production usage — its
        // consumption of this container's stock was already reversed by the
        // delete route (factoryMixBatchRoutes.ts). Without this filter, a
        // deleted batch's stale, never-reset usedKg field permanently blocks
        // reversing the offload even though nothing is actually consuming the
        // stock anymore.
        isNull(factoryMixBatches.deletedAt)
      )
    );

  return usedBatches.map((batch) => batch.batchCode);
}

/**
 * POST /api/factory/containers/:id/reverse-offload — undoes an offload,
 * unwinding the raw stock, its receipts, commissions, additional charges and
 * every voucher and daybook entry the offload posted.
 *
 * It is the inverse of the offload handler rather than part of it: the two
 * shared a file but no code. Registered from the same point in the same order,
 * so config/route-manifest.json is unchanged.
 */
export function registerRawStockReverseOffloadRoute(app: Express) {
  app.post("/api/factory/containers/:id/reverse-offload", requireAuth, async (req, res) => {
    try {
      // factoryCompanyId is not declared on SessionData; the cast stays until it is.
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });

      const [container] = await db
        .select()
        .from(factoryContainers)
        .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

      if (!container) return res.status(404).json({ message: "Container not found" });
      if (!isReversibleStatus(container.status)) {
        return res.status(400).json({ message: REVERSAL_STATUS_MESSAGE });
      }

      // Early, unlocked copy of the consumption guard so the common rejection does
      // not open a transaction. It is repeated on the locked row below, which is
      // the check that actually decides anything.
      const earlyBlockedBy = await findConsumingMixBatchCodes(db, companyId, containerId);
      if (earlyBlockedBy.length > 0) {
        return res.status(400).json({ message: consumingMixBatchMessage(earlyBlockedBy) });
      }

      const requestId = resolveOptionalFinancialOperationKey(req);

      const reverseOffload = async (tx: DbTransaction, _identity: string): Promise<ReverseOffloadOutcome> => {
        // The container row is the reversal's ownership token. Locking it before
        // anything is read is what makes a double-submit safe: without it two
        // simultaneous reversals both saw OFFLOADED, both deleted the offload's
        // daybook and vouchers, both re-applied the supplier locked-rate
        // correction, and both re-posted the pre-offload freight voucher — one
        // reversal requested, two sets of financial effects committed.
        const [lockedContainer] = await tx
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
          .for("update");

        if (!lockedContainer) throw new ReverseOffloadError("Container not found", 404);
        if (!isReversibleStatus(lockedContainer.status)) {
          // Already reversed by the request that held the lock first. Reported as
          // 400 rather than 409 on purpose: the client's accounting-identity guard
          // treats a codeless 409 as an uncertain outcome and would keep the
          // request identity pending forever, retrying a reversal that is
          // definitively finished.
          throw new ReverseOffloadError(REVERSAL_STATUS_MESSAGE, 400);
        }

        const blockedBy = await findConsumingMixBatchCodes(tx, companyId, containerId);
        if (blockedBy.length > 0) {
          throw new ReverseOffloadError(consumingMixBatchMessage(blockedBy), 400);
        }

        const container = lockedContainer;
        // 1. Find the raw stock entry for this container (fetch full cost fields
        //    so we can compute the supplier locked-rate correction below).
        const [rawStockRow] = await tx
          .select({
            id: factoryRawStock.id,
            receivedKg: factoryRawStock.receivedKg,
            usedKg: factoryRawStock.usedKg,
            costPerKgUsd: factoryRawStock.costPerKgUsd,
          })
          .from(factoryRawStock)
          .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));

        // 2. Find commission records for this container
        const commissionRows = await tx
          .select({ id: factoryContainerCommissions.id })
          .from(factoryContainerCommissions)
          .where(
            and(
              eq(factoryContainerCommissions.companyId, companyId),
              eq(factoryContainerCommissions.containerId, containerId)
            )
          );
        const commissionIds = commissionRows.map((r) => r.id);
        const _hadOffloadCommission = commissionRows.length > 0;

        // 3. Delete daybook entries tied to this offload:
        //    - OFFLOAD_RAW_STOCK referencing the raw stock row id
        //    - COMMISSION referencing each commission record id
        //    - FREIGHT / OTHER_CHARGE / DUTY referencing the container id
        if (rawStockRow) {
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "OFFLOAD_RAW_STOCK"),
                eq(factoryDaybookEntries.referenceId, rawStockRow.id)
              )
            );
        }
        if (commissionIds.length > 0) {
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "COMMISSION"),
                inArray(factoryDaybookEntries.referenceId, commissionIds)
              )
            );
        }
        // FREIGHT, OTHER_CHARGE, DUTY entries all reference containerId directly
        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              inArray(factoryDaybookEntries.txType, ["FREIGHT", "OTHER_CHARGE", "DUTY"]),
              eq(factoryDaybookEntries.referenceId, containerId)
            )
          );

        // 4. Delete all double-entry accounting vouchers created at or after offload for this container:
        //    FACTORY-COMM-{id}-*   commission vouchers (from offload or pre-registration)
        //    FACTORY-FREIGHT-{id}-*  freight vouchers
        //    FACTORY-OC-{id}-*       other-charge and additional-charge vouchers
        //    (FACTORY-IMPORT-{id}-* and FACTORY-PAY-* are intentionally preserved)
        const containerVouchers = await tx
          .select({ id: vouchers.id })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              eq(vouchers.sourceModule, "FACTORY"),
              or(
                ilike(vouchers.voucherNumber, `FACTORY-COMM-${containerId}-%`),
                ilike(vouchers.voucherNumber, `FACTORY-FREIGHT-${containerId}-%`),
                ilike(vouchers.voucherNumber, `FACTORY-OC-${containerId}-%`)
              )
            )
          );
        if (containerVouchers.length > 0) {
          const vIds = containerVouchers.map((v) => v.id);
          await tx.delete(voucherEntries).where(inArray(voucherEntries.voucherId, vIds));
          await tx.delete(vouchers).where(inArray(vouchers.id, vIds));
        }

        // 4b. Correct the supplier's locked rate before removing this container's
        //     stock. The offload moving-average blended this container's cost/kg
        //     into the supplier rate; reversing the offload must undo that blend.
        //
        //     Formula:
        //       supplierRemainingKgBefore = authoritative remaining kg (includes this row)
        //       containerRemainingKg      = rawStock.receivedKg - rawStock.usedKg
        //       supplierValueBefore       = supplierRemainingKgBefore × currentLockedRate
        //       containerRemainingValue   = containerRemainingKg × rawStock.costPerKgUsd
        //       supplierRemainingKgAfter  = supplierRemainingKgBefore − containerRemainingKg
        //       newLockedRate             = (supplierValueBefore − containerRemainingValue)
        //                                    ÷ supplierRemainingKgAfter  (or 0 when denom ≤ 0)
        if (container.supplierId && rawStockRow) {
          const currentLockedRate = await getLockedSupplierRate(tx, companyId, container.supplierId, {
            forUpdate: true,
          });
          const supplierRemainingKgBefore = new Decimal(
            await getAuthoritativeSupplierRemainingKg(tx, companyId, container.supplierId)
          );
          const containerRemainingKg = new Decimal(rawStockRow.receivedKg || "0").minus(
            new Decimal(rawStockRow.usedKg || "0")
          );
          const supplierValueBefore = supplierRemainingKgBefore.times(currentLockedRate);
          const containerRemainingValue = containerRemainingKg.times(new Decimal(rawStockRow.costPerKgUsd || "0"));
          const supplierRemainingKgAfter = supplierRemainingKgBefore.minus(containerRemainingKg);
          let newLockedRate: Decimal;
          if (supplierRemainingKgAfter.lte(0)) {
            newLockedRate = new Decimal(0);
          } else {
            newLockedRate = supplierValueBefore.minus(containerRemainingValue).div(supplierRemainingKgAfter);
            // Clamp tiny floating-point negatives caused by rounding
            if (newLockedRate.lt(0)) newLockedRate = new Decimal(0);
          }
          await tx
            .update(factorySuppliers)
            .set({
              currentRawMaterialCostPerKgUsd: newLockedRate.toDecimalPlaces(8).toFixed(8),
              updatedAt: new Date(),
            })
            .where(and(eq(factorySuppliers.id, container.supplierId), eq(factorySuppliers.companyId, companyId)));
        }

        // 4c. Soft-delete all receipt history for this container — marks every
        //     factoryContainerReceipts row as deleted so subsequent receipt queries
        //     (and the available-containers endpoint) see a clean slate. Hard-deletes
        //     of raw stock and commission follow below.
        await tx
          .update(factoryContainerReceipts)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(factoryContainerReceipts.companyId, companyId),
              eq(factoryContainerReceipts.containerId, containerId),
              isNull(factoryContainerReceipts.deletedAt)
            )
          );

        // 5. Delete offload records: raw stock, commission records, additional charges, mix-batch links
        await tx
          .delete(factoryRawStock)
          .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));
        await tx
          .delete(factoryContainerCommissions)
          .where(
            and(
              eq(factoryContainerCommissions.companyId, companyId),
              eq(factoryContainerCommissions.containerId, containerId)
            )
          );
        await tx
          .delete(factoryOffloadAdditionalCharges)
          .where(
            and(
              eq(factoryOffloadAdditionalCharges.companyId, companyId),
              eq(factoryOffloadAdditionalCharges.containerId, containerId)
            )
          );
        // Remove mix-batch source links created during offload for this container
        await tx.delete(factoryMixBatchSources).where(eq(factoryMixBatchSources.containerId, containerId));

        // 6. Restore pre-offload charges and reset container to RECEIVED status.
        //    If a pre-offload snapshot exists (set during offload), restore those values
        //    so that charges entered at container-creation time are preserved.
        //    If no snapshot exists (container was offloaded before this logic was added),
        //    fall back to zeroing out the charges (legacy behaviour).
        const preFreight = container.preOffloadFreight;
        const hasSnapshot = preFreight !== null && preFreight !== undefined;
        const restoredFreight = hasSnapshot ? String(preFreight || "0") : "0";
        const restoredFreightAccountId = hasSnapshot ? container.preOffloadFreightAccountId || null : null;
        const restoredFreightSupplierId = hasSnapshot ? container.preOffloadFreightSupplierId || null : null;
        const restoredFreightCurrencyCode = hasSnapshot
          ? container.preOffloadFreightCurrencyCode || container.currencyCode || "USD"
          : container.currencyCode || "USD";
        const restoredOtherCharges = hasSnapshot ? String(container.preOffloadOtherCharges || "0") : "0";
        const restoredOtherChargesAccountId = hasSnapshot ? container.preOffloadOtherChargesAccountId || null : null;
        const restoredOtherChargesSupplierId = hasSnapshot ? container.preOffloadOtherChargesSupplierId || null : null;

        // Re-post the original creation-time FACTORY-FREIGHT voucher if one existed
        // before offload. The number matches the one factory container creation
        // posts (`FACTORY-FREIGHT-{containerId}`) rather than carrying a timestamp:
        // this is the same voucher being restored, so it keeps one identity that the
        // next offload's cleanup can find exactly.
        const restoredFreightAmt = parseFloat(restoredFreight || "0");
        // A voucher with only a debit leg is an unbalanced posting: it inflates one
        // side of the ledger and reports as VOUCHER_NOT_BALANCED in the convergence
        // reconciliation. The freight credit has to land on somebody — the paying
        // supplier, or the company's own account when it paid the freight itself —
        // so resolve the counterparty first and only post when both legs exist.
        const restoredFreightCreditSupplierId = restoredFreightSupplierId ?? null;
        const restoredFreightCreditAccountId = Number(container.freightOwnAccountId ?? NaN);
        const hasRestoredFreightCreditLedger = Number.isInteger(restoredFreightCreditAccountId);
        if (
          restoredFreightAmt > 0 &&
          restoredFreightAccountId &&
          (restoredFreightCreditSupplierId !== null || hasRestoredFreightCreditLedger)
        ) {
          const restoredFreightVoucherNum = `FACTORY-FREIGHT-${containerId}`;
          const [restoredFreightVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: restoredFreightVoucherNum,
              voucherDate: container.arrivalDate || getClientDate(req),
              description: `Freight on container ${container.containerNumber}`,
              totalAmount: String(restoredFreightAmt),
              currency: restoredFreightCurrencyCode,
              // This re-posts a voucher that already existed pre-offload, using the
              // exact rate the original offload already booked its financials with —
              // it is not a new forward-going financial decision, so we reuse the
              // container's stored rate as-is rather than requiring it to be
              // "confirmed" (which would incorrectly block reversing legacy
              // containers offloaded before the fxRateConfirmed flag existed).
              exchangeRate: String(container.fxRateToUsd ?? "1"),
              sourceModule: "FACTORY",
            })
            .returning();
          // Dr Freight Expense
          await tx.insert(voucherEntries).values({
            voucherId: restoredFreightVoucher.id,
            ledgerAccountId: restoredFreightAccountId,
            debitAmount: String(restoredFreightAmt),
            creditAmount: "0",
            narration: `Freight expense - container ${container.containerNumber}`,
          });
          // Cr: supplier when pre-offload freight was supplier-paid;
          //     own account when it was own-account paid (never fall back
          //     to container.supplierId — that would silently debit the
          //     material supplier for freight they didn't owe).
          if (restoredFreightCreditSupplierId !== null) {
            await tx.insert(voucherEntries).values({
              voucherId: restoredFreightVoucher.id,
              factorySupplierId: restoredFreightCreditSupplierId,
              debitAmount: "0",
              creditAmount: String(restoredFreightAmt),
              narration: `Freight payable to supplier - container ${container.containerNumber}`,
            });
          } else if (hasRestoredFreightCreditLedger) {
            await tx.insert(voucherEntries).values({
              voucherId: restoredFreightVoucher.id,
              ledgerAccountId: restoredFreightCreditAccountId,
              debitAmount: "0",
              creditAmount: String(restoredFreightAmt),
              narration: `Freight paid via own account - container ${container.containerNumber}`,
            });
          }
        } else if (restoredFreightAmt > 0 && restoredFreightAccountId) {
          // The freight itself is still restored onto the container in step 10, so
          // no amount is lost — but with no counterparty to credit there is no
          // balanced voucher to post. Recorded rather than silently half-booked.
          logger.warn("reverse-offload skipped a freight voucher with no credit leg", {
            module: "factoryRawStock",
            action: "reverseOffload",
            companyId,
            containerId,
            freightAmount: restoredFreightAmt,
            freightAccountId: restoredFreightAccountId,
            freightSupplierId: restoredFreightSupplierId,
            freightOwnAccountId: container.freightOwnAccountId,
          });
        }

        // Restore pre-offload commission snapshot (if one was saved)
        const preCommAmt = container.preOffloadCommissionAmount;
        const hasCommSnapshot = preCommAmt !== null && preCommAmt !== undefined;
        const restoredCommissionAmount = hasCommSnapshot ? String(preCommAmt || "0") : "0";
        const restoredCommissionCurrencyCode = hasCommSnapshot
          ? container.preOffloadCommissionCurrencyCode || "USD"
          : "USD";
        const restoredCommissionAccountId = hasCommSnapshot ? container.preOffloadCommissionAccountId || null : null;
        const restoredCommissionSupplierId = hasCommSnapshot ? container.preOffloadCommissionSupplierId || null : null;
        const restoredCommissionNotes = hasCommSnapshot ? container.preOffloadCommissionNotes || null : null;

        // Restore pre-offload status (fallback to "ARRIVED" for legacy containers without snapshot)
        const restoredStatus = container.preOffloadStatus || "ARRIVED";

        await tx
          .update(factoryContainers)
          .set({
            status: restoredStatus,
            actualReceivedKg: null,
            differenceKg: null,
            declaredKg: null,
            // Restore pre-offload freight (or zero if no snapshot)
            freight: restoredFreight,
            freightCurrencyCode: restoredFreightCurrencyCode,
            freightAccountId: restoredFreightAccountId,
            freightSupplierId: restoredFreightSupplierId,
            // Restore pre-offload other charges (or zero if no snapshot)
            otherCharges: restoredOtherCharges,
            otherChargesAccountId: restoredOtherChargesAccountId,
            otherChargesSupplierId: restoredOtherChargesSupplierId,
            // Restore pre-offload commission
            commissionAmount: restoredCommissionAmount,
            commissionCurrencyCode: restoredCommissionCurrencyCode,
            commissionAccountId: restoredCommissionAccountId,
            commissionSupplierId: restoredCommissionSupplierId,
            commissionNotes: restoredCommissionNotes,
            // Clear duty (always offload-specific)
            dutyAmount: null,
            dutyAccountId: null,
            dutyStatus: "NONE",
            dutyNotes: null,
            // Clear computed financials
            finalPayableAmount: null,
            finalPayableAmountUsd: null,
            ratePerKgUsd: null,
            fxRateToUsdOffload: null,
            fxRateDateOffload: null,
            // Clear the pre-offload snapshot columns
            preOffloadFreight: null,
            preOffloadFreightCurrencyCode: null,
            preOffloadFreightAccountId: null,
            preOffloadFreightSupplierId: null,
            preOffloadOtherCharges: null,
            preOffloadOtherChargesAccountId: null,
            preOffloadOtherChargesSupplierId: null,
            preOffloadStatus: null,
            preOffloadCommissionAmount: null,
            preOffloadCommissionCurrencyCode: null,
            preOffloadCommissionAccountId: null,
            preOffloadCommissionSupplierId: null,
            preOffloadCommissionNotes: null,
            updatedAt: new Date(),
          })
          .where(eq(factoryContainers.id, containerId));

        return { message: REVERSAL_SUCCESS_MESSAGE, containerStatus: container.status };
      };

      // The reversal is one indivisible unit of work. With a caller-supplied
      // request identity it also becomes a durable operation, so a client retry
      // after an uncertain response replays the stored outcome instead of running
      // the reversal a second time against a container that is no longer OFFLOADED.
      const outcome: ReverseOffloadOutcome = requestId
        ? (
            await withDurableFinancialOperation<ReverseOffloadOutcome>(
              {
                companyId,
                operationName: "factory.container.reverse-offload",
                idempotencyKey: requestId,
                requestFingerprint: financialOperationFingerprint({
                  method: req.method,
                  path: req.originalUrl,
                  companyId,
                  body: financialOperationRequestPayload(req.body),
                }),
              },
              async (tx) => ({ value: await reverseOffload(tx, requestId) })
            )
          ).value
        : await db.transaction((tx) => reverseOffload(tx, ""));

      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || req.session.userId!,
        companyId,
        action: "reverse",
        tableName: "production_raw_stock",
        recordId: containerId,
        recordIdentifier: `Container #${containerId} offload reversed`,
        changes: null,
      });
      res.json({ message: outcome.message });
    } catch (error: unknown) {
      if (error instanceof ReverseOffloadError) {
        return res.status(error.status).json({ message: error.message });
      }
      if (error instanceof DurableFinancialOperationError) {
        return res.status(financialOperationErrorStatus(error)).json({ message: error.message });
      }
      logger.error("Error reversing offload:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
