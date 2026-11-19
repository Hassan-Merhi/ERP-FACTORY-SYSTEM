import { eq, and, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../../../db";
import {
  factoryContainers,
  factoryRawStock,
  factoryOffloadAdditionalCharges,
  factoryContainerCommissions,
  factoryContainerOtherCharges,
} from "@shared/schema";
import { cascadeContainerCostChange } from "../rawStockCostCascade";
import { computeCorrectContainerCost, computeRecalcFingerprint, costRound } from "./cost-math";
import { toMoney } from "../../../lib/money";
import {
  RECALC_REFUSED_STATUSES,
  isFullyCorrect,
  type ApplyResult,
  type ApplyRawStockRecalcOptions,
} from "./applyIsFullyCorrect";
export type { ApplyResult, ApplyRawStockRecalcOptions } from "./applyIsFullyCorrect";

const RECALC_LOCK_NAMESPACE = 9001;

export async function applyRawStockRecalc(
  companyId: number,
  containerIds: number[],
  opts: ApplyRawStockRecalcOptions = {}
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];

  for (const containerId of containerIds) {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${RECALC_LOCK_NAMESPACE}, ${containerId})`);

      const [container] = await tx
        .select()
        .from(factoryContainers)
        .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
        .for("update");
      if (!container) {
        return {
          containerId,
          containerNumber: String(containerId),
          fullyUsed: false,
          remainingKg: 0,
          applied: false,
          skippedReason: `Container #${containerId} not found for this company — possible company_id mismatch between factory_raw_stock and factory_containers.`,
          rawStockRowsUpdated: 0,
          affectedBatches: 0,
          affectedBales: 0,
        } as ApplyResult;
      }

      // Guard: refuse CLOSED/COMPLETED unless admin explicitly opts in
      if (RECALC_REFUSED_STATUSES.has(container.status) && !opts.includeHistoricalContainers) {
        return {
          containerId,
          containerNumber: container.containerNumber,
          fullyUsed: false,
          remainingKg: 0,
          applied: false,
          skippedReason: `Container status is ${container.status} — pass includeHistoricalContainers to repair historical containers.`,
          rawStockRowsUpdated: 0,
          affectedBatches: 0,
          affectedBales: 0,
        } as ApplyResult;
      }

      const [additionalCharges, commissionRecords, otherChargesRows] = await Promise.all([
        tx
          .select()
          .from(factoryOffloadAdditionalCharges)
          .where(
            and(
              eq(factoryOffloadAdditionalCharges.containerId, containerId),
              eq(factoryOffloadAdditionalCharges.companyId, companyId)
            )
          ),
        tx
          .select()
          .from(factoryContainerCommissions)
          .where(
            and(
              eq(factoryContainerCommissions.containerId, containerId),
              eq(factoryContainerCommissions.companyId, companyId)
            )
          ),
        tx
          .select()
          .from(factoryContainerOtherCharges)
          .where(
            and(
              eq(factoryContainerOtherCharges.containerId, containerId),
              eq(factoryContainerOtherCharges.companyId, companyId)
            )
          ),
      ]);
      const commissionRecord = commissionRecords.sort((a, b) => b.id - a.id)[0] || null;

      const rawStockRows = await tx
        .select()
        .from(factoryRawStock)
        .where(
          and(
            eq(factoryRawStock.containerId, containerId),
            eq(factoryRawStock.companyId, companyId),
            isNull(factoryRawStock.deletedAt)
          )
        );
      const rawStockRow = rawStockRows[0] || null;

      const next = computeCorrectContainerCost(container, additionalCharges, commissionRecord, otherChargesRows);

      if (next.fxUnresolved) {
        return {
          containerId,
          containerNumber: container.containerNumber,
          fullyUsed: false,
          remainingKg: 0,
          applied: false,
          skippedReason: "FX rate is unresolved — never auto-apply a recompute derived from a guessed rate.",
          rawStockRowsUpdated: 0,
          affectedBatches: 0,
          affectedBales: 0,
        } as ApplyResult;
      }
      if (next.costPerKgUsd === 0 && next.costPerKg === 0) {
        return {
          containerId,
          containerNumber: container.containerNumber,
          fullyUsed: false,
          remainingKg: 0,
          applied: false,
          skippedReason: "No received kg — nothing to recompute.",
          rawStockRowsUpdated: 0,
          affectedBatches: 0,
          affectedBales: 0,
        } as ApplyResult;
      }

      // Multi-layer "already correct" check (all 3 layers must match)
      const alreadyCorrect = await isFullyCorrect(tx, containerId, next, container, rawStockRow);
      if (alreadyCorrect) {
        const receivedKg = toMoney(container.actualReceivedKg).toNumber();
        const usedKg = rawStockRow ? toMoney(rawStockRow.usedKg).toNumber() : receivedKg;
        const remainingKg = Math.max(0, receivedKg - usedKg);
        return {
          containerId,
          containerNumber: container.containerNumber,
          fullyUsed: receivedKg > 0 && remainingKg === 0,
          remainingKg,
          applied: false,
          skippedReason: "All valuation layers already match the corrected value — idempotent no-op.",
          rawStockRowsUpdated: 0,
          affectedBatches: 0,
          affectedBales: 0,
        } as ApplyResult;
      }

      // Fingerprint check (inside row lock — catches concurrent edits)
      const expectedFingerprint = opts.expectedFingerprints?.[containerId];
      if (expectedFingerprint) {
        const freshFingerprint = computeRecalcFingerprint({
          container,
          additionalCharges,
          commissionRecord,
          rawStock: rawStockRow,
          otherChargesRows,
        });
        if (freshFingerprint !== expectedFingerprint) {
          return {
            containerId,
            containerNumber: container.containerNumber,
            fullyUsed: false,
            remainingKg: 0,
            applied: false,
            staleToken: true,
            skippedReason:
              "Container's approved calculation inputs changed since the confirmation token was issued — re-run the dry-run preview and try again.",
            rawStockRowsUpdated: 0,
            affectedBatches: 0,
            affectedBales: 0,
          } as ApplyResult;
        }
      }

      // Determine fully-used before writing (for locked-rate decision)
      const receivedKg = toMoney(container.actualReceivedKg).toNumber();
      const usedKg = rawStockRow ? toMoney(rawStockRow.usedKg).toNumber() : receivedKg;
      const remainingKg = Math.max(0, receivedKg - usedKg);
      const fullyUsed = receivedKg > 0 && remainingKg === 0;

      // Update container snapshot
      await tx
        .update(factoryContainers)
        .set({
          finalPayableAmount: String(next.totalCost),
          ratePerKgUsd: costRound(next.costPerKgUsd),
          finalPayableAmountUsd: String(next.totalUsd),
          updatedAt: new Date(),
        })
        .where(eq(factoryContainers.id, containerId));

      // The cascade naturally skips supplier locked-rate for fully-used containers
      // because remainingKg=0 makes dCorrectedContainerRemainingKg=0. No extra param needed.
      const cascadeResult = await cascadeContainerCostChange(
        tx,
        { companyId, containerId, newCostPerKg: next.costPerKg, newCostPerKgUsd: next.costPerKgUsd },
        { includeCompletedBatches: opts.includeCompletedBatches }
      );

      // Quantity invariant: verify the cascade touched ONLY cost fields.
      // If receivedKg or usedKg changed inside the transaction, roll back immediately.
      if (rawStockRow) {
        const [rsAfter] = await tx
          .select({ receivedKg: factoryRawStock.receivedKg, usedKg: factoryRawStock.usedKg })
          .from(factoryRawStock)
          .where(eq(factoryRawStock.id, rawStockRow.id));
        if (rsAfter) {
          const receivedBefore = new Decimal(rawStockRow.receivedKg || "0").toDecimalPlaces(3);
          const usedBefore = new Decimal(rawStockRow.usedKg || "0").toDecimalPlaces(3);
          const receivedAfter = new Decimal(rsAfter.receivedKg || "0").toDecimalPlaces(3);
          const usedAfter = new Decimal(rsAfter.usedKg || "0").toDecimalPlaces(3);
          if (!receivedBefore.equals(receivedAfter) || !usedBefore.equals(usedAfter)) {
            throw new Error("Cost recalculation attempted to change raw-stock quantities. Operation rolled back.");
          }
        }
      }

      const applyResult: ApplyResult = {
        containerId,
        containerNumber: container.containerNumber,
        fullyUsed,
        remainingKg,
        applied: true,
        rawStockRowsUpdated: cascadeResult.rawStockRowsUpdated,
        affectedBatches: cascadeResult.affectedBatches.length,
        affectedBales: cascadeResult.affectedBales.length,
        completedBatchesRewritten: cascadeResult.affectedBatches.filter((b) => b.wasCompleted).length,
      };

      if (opts.onAudit) {
        await opts.onAudit(tx, applyResult);
      }

      return applyResult;
    });

    if (result) results.push(result);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// getMixBatchSourceCostMismatchPreview — full scan (replaces zero-cost-only)
// ─────────────────────────────────────────────────────────────────────────────
