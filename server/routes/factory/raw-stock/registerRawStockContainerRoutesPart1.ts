// Extracted from ./rawStockContainerRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../../../lib/parseId";
import type Decimal from "decimal.js";
import { parseMoneyInput, toMoney } from "../../../lib/money";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { cascadeContainerCostChange } from "../../../services/factory/rawStockCostCascade";
import { computeCorrectContainerCost } from "../../../services/factory/raw-stock-recalc";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../../services/factory/currencyConversion";
import { writeDaybookEntry } from "../_helpers";
import { factoryDocumentRate } from "../../../services/factory/factoryDocumentFxRate";
import {
  factoryContainerCommissions,
  factoryContainers,
  factoryDutyAuditLog,
  factoryOffloadAdditionalCharges,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";

export const ADMIN_ROLES = ["Admin", "Developer"] as const;

/**
 * Resolve FX rate for a post-offload charge (create or edit).
 * Always returns fxRateConfirmed: true.
 * Rules:
 *  A) USD charge                   → fxRateToUsd = 1,   fxRateDate = txDate
 *  B) Same CCY as container        → use confirmed container offload FX
 *  C) Third currency               → the recorded factory rate on or before txDate
 *     (manual, else recorded auto; phase 19 C, M2: it used to fetch an external
 *     rate and mark it confirmed), else FactoryFxRateRequiredError (409)
 */
export async function resolvePostOffloadChargeFx(opts: {
  chargeCcy: string;
  containerCcy: string;
  containerFxRate: number;
  containerFxRateDateOffload: string | null;
  containerFxConfirmed: boolean;
  txDate: string;
  companyId: number;
}): Promise<{ fxRateToUsd: number; fxRateConfirmed: boolean; fxRateDate: string }> {
  const {
    chargeCcy,
    containerCcy,
    containerFxRate,
    containerFxRateDateOffload,
    containerFxConfirmed,
    txDate,
    companyId,
  } = opts;
  if (chargeCcy === "USD") {
    return { fxRateToUsd: 1, fxRateConfirmed: true, fxRateDate: txDate };
  }
  if (chargeCcy === containerCcy) {
    if (!containerFxConfirmed) {
      throw new Error(`Container FX rate for ${containerCcy} is not confirmed. Confirm the container FX rate first.`);
    }
    return { fxRateToUsd: containerFxRate, fxRateConfirmed: true, fxRateDate: containerFxRateDateOffload || txDate };
  }
  // Third currency — the recorded dated factory rate
  const recorded = await factoryDocumentRate(db, companyId, chargeCcy, txDate);
  return { fxRateToUsd: toMoney(recorded.rate).toNumber(), fxRateConfirmed: true, fxRateDate: txDate };
}

/**
 * A request amount that must be a positive number, read the way parseFloat
 * read it; null when it is missing, does not parse or is not above zero. The
 * old "not above zero" checks on a float let a non-numeric value through as NaN.
 */
export function positiveRequestAmount(value: unknown): Decimal | null {
  const parsed = value ? parseMoneyInput(value) : null;
  return parsed && parsed.greaterThan(0) ? parsed : null;
}

export function registerRawStockContainerRoutesPart1(app: Express) {
  app.patch("/api/factory/containers/:id/confirm-duty", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const { dutyAmount, dutyNotes } = req.body;
      const userId = String(req.session.userId || req.user?.id || "system");

      const dutyAmountExact = positiveRequestAmount(dutyAmount);
      if (!dutyAmountExact) {
        return res.status(400).json({ message: "Valid duty amount is required" });
      }

      const [container] = await db
        .select()
        .from(factoryContainers)
        .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));

      if (!container) return res.status(404).json({ message: "Container not found" });
      if (container.dutyStatus !== "PENDING") {
        return res.status(400).json({ message: "Only containers with PENDING duty can be confirmed" });
      }

      const newDutyAmount = dutyAmountExact;
      let resultCostPerKg: number | null = null;

      // ── Single atomic transaction: all reads + writes happen together ─────────
      // Locking the container FOR UPDATE prevents concurrent duty confirmations or
      // offload mutations from racing this route. All financial writes (duty fields,
      // financials, cascade, daybook) are inside one transaction — a partial failure
      // rolls everything back.
      await db.transaction(async (tx) => {
        // 1. Lock container FOR UPDATE — authoritative source for all reads below.
        const [lockedContainer] = await tx
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)))
          .for("update");

        if (!lockedContainer) throw Object.assign(new Error("Container not found"), { status: 404 });
        if (lockedContainer.dutyStatus !== "PENDING") {
          throw Object.assign(new Error("Only containers with PENDING duty can be confirmed"), { status: 400 });
        }

        // 2. Load charges and commission inside the transaction.
        const additionalChargesRows = await tx
          .select()
          .from(factoryOffloadAdditionalCharges)
          .where(
            and(
              eq(factoryOffloadAdditionalCharges.containerId, containerId),
              eq(factoryOffloadAdditionalCharges.companyId, companyId)
            )
          );

        const commissionRows = await tx
          .select()
          .from(factoryContainerCommissions)
          .where(
            and(
              eq(factoryContainerCommissions.containerId, containerId),
              eq(factoryContainerCommissions.companyId, companyId)
            )
          );
        const commissionRecord = commissionRows.sort((a, b) => b.id - a.id)[0] || null;

        // 3. Build in-memory snapshot with the confirmed duty so the helper sees the
        //    correct, complete cost picture without a second round-trip.
        const containerSnapshot = {
          ...lockedContainer,
          dutyAmount: newDutyAmount.toFixed(),
          dutyStatus: "CONFIRMED" as string,
          dutyNotes: dutyNotes || lockedContainer.dutyNotes,
        };

        // 4. Compute new inclusive landed cost — pure computation, no db calls.
        const next = computeCorrectContainerCost(containerSnapshot, additionalChargesRows, commissionRecord);
        if (next.fxUnresolved) {
          const fxError: Error & { status?: number } = new Error(
            new UnresolvedExchangeRateError(lockedContainer.currencyCode || "USD").message
          );
          fxError.status = 400;
          throw fxError;
        }
        resultCostPerKg = next.costPerKg;

        // 5. Insert duty audit log — atomic with the update.
        await tx.insert(factoryDutyAuditLog).values({
          companyId,
          containerId,
          oldDutyAmount: lockedContainer.dutyAmount || "0",
          newDutyAmount: newDutyAmount.toFixed(),
          oldDutyStatus: lockedContainer.dutyStatus,
          newDutyStatus: "CONFIRMED",
          notes: dutyNotes || null,
          updatedByUserId: userId,
        });

        // 6. Persist confirmed duty + recalculated financials in one UPDATE.
        await tx
          .update(factoryContainers)
          .set({
            dutyAmount: newDutyAmount.toFixed(),
            dutyStatus: "CONFIRMED",
            dutyNotes: dutyNotes || lockedContainer.dutyNotes,
            finalPayableAmount: String(next.totalCost),
            ratePerKgUsd: String(next.costPerKgUsd),
            finalPayableAmountUsd: String(next.totalUsd),
            updatedAt: new Date(),
          })
          .where(eq(factoryContainers.id, containerId));

        // 7. Cascade the updated cost to raw stock and any still-OPEN mix batches.
        await cascadeContainerCostChange(tx, {
          companyId,
          containerId,
          newCostPerKg: next.costPerKg,
          newCostPerKgUsd: next.costPerKgUsd,
        });

        // 8. Daybook entry for the duty confirmation.
        const { fxRate } = resolveStoredFxRate(
          lockedContainer.currencyCode,
          lockedContainer.fxRateToUsdOffload || lockedContainer.fxRateToUsd,
          lockedContainer.fxRateConfirmed
        );
        const today = req.body.txDate || getClientDate(req);
        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: "DUTY",
          referenceId: containerId,
          referenceTable: "factory_containers",
          description: `Duty confirmed for container ${lockedContainer.containerNumber}: ${newDutyAmount.toFixed(2)}`,
          currencyCode: lockedContainer.currencyCode || "USD",
          amountCurrency: newDutyAmount.toNumber(),
          fxRateToUsd: fxRate,
        });
      });

      res.json({ message: "Duty confirmed and costs recalculated", newCostPerKg: resultCostPerKg });
    } catch (error: unknown) {
      logger.error("Error confirming duty:", { error: error });
      res.status((error as { status: number }).status || 500).json({ message: getErrorMessage(error) });
    }
  });
}
