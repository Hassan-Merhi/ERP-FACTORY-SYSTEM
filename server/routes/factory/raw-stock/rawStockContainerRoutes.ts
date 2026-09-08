import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import {
  applyPostOffloadChargeMutation,
  type AccountingContext,
  type PostOffloadMutationResult,
} from "../../../services/factory/post-offload-charge";
import { cascadeContainerCostChange, type CascadeResult } from "../../../services/factory/rawStockCostCascade";
import { computeCorrectContainerCost } from "../../../services/factory/raw-stock-recalc";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../../services/factory/currencyConversion";
import { writeDaybookEntry, getOrFetchFxRateToUsd, getOrCreateLedgerAccount } from "../_helpers";
import {
  factoryContainers,
  factoryRawStock,
  factoryContainerCommissions,
  ledgerAccounts,
  factoryDutyAuditLog,
  factoryOffloadAdditionalCharges,
} from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";

const ADMIN_ROLES = ["Admin", "Developer"] as const;

/**
 * Resolve FX rate for a post-offload charge (create or edit).
 * Always returns fxRateConfirmed: true.
 * Rules:
 *  A) USD charge                   → fxRateToUsd = 1,   fxRateDate = txDate
 *  B) Same CCY as container        → use confirmed container offload FX
 *  C) Third currency               → fetch via getOrFetchFxRateToUsd, must be > 0
 */
async function resolvePostOffloadChargeFx(opts: {
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
  // Third currency — fetch independently
  const fetched = await getOrFetchFxRateToUsd(companyId, chargeCcy, txDate);
  const rate = parseFloat(fetched);
  if (!rate || rate <= 0) {
    throw new Error(
      `Cannot resolve FX rate for charge currency ${chargeCcy} on ${txDate}. Add an FX rate for this currency first.`
    );
  }
  return { fxRateToUsd: rate, fxRateConfirmed: true, fxRateDate: txDate };
}

export function registerRawStockContainerRoutes(app: Express) {
  app.patch("/api/factory/containers/:id/confirm-duty", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const { dutyAmount, dutyNotes } = req.body;
      const userId = String(req.session.userId || req.user?.id || "system");

      if (!dutyAmount || parseFloat(dutyAmount) <= 0) {
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

      const newDutyAmount = parseFloat(dutyAmount);
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
          dutyAmount: String(newDutyAmount),
          dutyStatus: "CONFIRMED" as string,
          dutyNotes: dutyNotes || lockedContainer.dutyNotes,
        };

        // 4. Compute new inclusive landed cost — pure computation, no db calls.
        const next = computeCorrectContainerCost(containerSnapshot, additionalChargesRows, commissionRecord);
        if (next.fxUnresolved) {
          throw Object.assign(
            new Error(new UnresolvedExchangeRateError(lockedContainer.currencyCode || "USD").message),
            { status: 400 }
          );
        }
        resultCostPerKg = next.costPerKg;

        // 5. Insert duty audit log — atomic with the update.
        await tx.insert(factoryDutyAuditLog).values({
          companyId,
          containerId,
          oldDutyAmount: lockedContainer.dutyAmount || "0",
          newDutyAmount: String(newDutyAmount),
          oldDutyStatus: lockedContainer.dutyStatus,
          newDutyStatus: "CONFIRMED",
          notes: dutyNotes || null,
          updatedByUserId: userId,
        });

        // 6. Persist confirmed duty + recalculated financials in one UPDATE.
        await tx
          .update(factoryContainers)
          .set({
            dutyAmount: String(newDutyAmount),
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
          amountCurrency: newDutyAmount,
          fxRateToUsd: fxRate,
        });
      });

      res.json({ message: "Duty confirmed and costs recalculated", newCostPerKg: resultCostPerKg });
    } catch (error: unknown) {
      logger.error("Error confirming duty:", { error: error });
      res.status((error as { status: number }).status || 500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Post-offload charges: add duties/charges after a container has been offloaded ──
  app.post("/api/factory/containers/:id/post-offload-charges", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });

      const { charges, txDate: reqTxDate } = req.body;
      if (!Array.isArray(charges) || charges.length === 0) {
        return res.status(400).json({ message: "At least one charge is required" });
      }

      const validCharges = charges.filter((c) => parseFloat(c.amount || "0") > 0);
      if (validCharges.length === 0) {
        return res.status(400).json({ message: "All charge amounts are zero" });
      }

      const [container] = await db
        .select()
        .from(factoryContainers)
        .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
      if (!container) return res.status(404).json({ message: "Container not found" });
      if (container.status !== "OFFLOADED" && container.status !== "PARTIALLY_RECEIVED") {
        return res.status(400).json({ message: "Can only add post-offload charges to offloaded containers" });
      }

      const txDate = reqTxDate || getClientDate(req);
      const containerCcy = container.currencyCode || "USD";
      const { fxRate: containerFxRate, looksSet: pocFxLooksSet } = resolveStoredFxRate(
        containerCcy,
        container.fxRateToUsdOffload || container.fxRateToUsd,
        container.fxRateConfirmed
      );
      if (!pocFxLooksSet) {
        return res.status(400).json({ message: new UnresolvedExchangeRateError(containerCcy).message });
      }
      if (parseFloat(container.actualReceivedKg || "0") <= 0) {
        return res.status(400).json({ message: "Container has no received weight" });
      }

      // Guard: raw-stock row must exist
      const rawStockCheck = await db
        .select({ id: factoryRawStock.id })
        .from(factoryRawStock)
        .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));
      if (rawStockCheck.length === 0) {
        return res.status(400).json({
          message: "Cannot add post-offload charge because this offloaded container has no linked raw-stock record.",
        });
      }

      const userId = String(req.session.userId || req.user?.id || "system");

      // Resolve FX and accounting context BEFORE transaction (may call external APIs)
      const resolvedChargeInputs: Array<{
        fxRateToUsd: number;
        fxRateConfirmed: boolean;
        fxRateDate: string;
        accountingCtx: AccountingContext;
      }> = [];

      for (const charge of validCharges) {
        const chargeCcy = charge.currencyCode || "USD";
        let fxResolved: { fxRateToUsd: number; fxRateConfirmed: boolean; fxRateDate: string };
        try {
          fxResolved = await resolvePostOffloadChargeFx({
            chargeCcy,
            containerCcy,
            containerFxRate,
            containerFxRateDateOffload: container.fxRateDateOffload || null,
            containerFxConfirmed: !!container.fxRateConfirmed,
            txDate,
            companyId,
          });
        } catch (e: unknown) {
          return res.status(400).json({ message: getErrorMessage(e) });
        }

        let acctCtx: AccountingContext = { voucherCompanyId: companyId, chargesPayableAcctId: 0 };
        if (charge.ledgerAccountId) {
          const lid = parseInt(charge.ledgerAccountId);
          const [acctRow] = await db
            .select({ companyId: ledgerAccounts.companyId })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.id, lid));
          const voucherCompanyId = acctRow?.companyId ?? companyId;
          const cpAcctId = await getOrCreateLedgerAccount(
            voucherCompanyId,
            "FACTORY_CHARGES_PAYABLE",
            "Factory Charges Payable"
          );
          acctCtx = { voucherCompanyId, chargesPayableAcctId: cpAcctId };
        } else if (charge.supplierId) {
          const cpAcctId = await getOrCreateLedgerAccount(
            companyId,
            "FACTORY_CHARGES_PAYABLE",
            "Factory Charges Payable"
          );
          acctCtx = { voucherCompanyId: companyId, chargesPayableAcctId: cpAcctId };
        }

        resolvedChargeInputs.push({ ...fxResolved, accountingCtx: acctCtx });
      }

      const oldContainerCostPerKgUsd = parseFloat(container.ratePerKgUsd || "0");
      const oldContainerTotalUsd = parseFloat(container.finalPayableAmountUsd || "0");

      let lastResult = null;
      const allCascadeResults: CascadeResult[] = [];

      await db.transaction(async (tx) => {
        for (let i = 0; i < validCharges.length; i++) {
          const charge = validCharges[i];
          const { fxRateToUsd, fxRateConfirmed, fxRateDate, accountingCtx } = resolvedChargeInputs[i];

          const mutResult = await applyPostOffloadChargeMutation(tx, {
            action: "CREATE",
            companyId,
            containerId,
            txDate,
            userId,
            chargeData: {
              description: charge.description || "Post-offload charge",
              amount: parseFloat(charge.amount),
              currencyCode: charge.currencyCode || "USD",
              fxRateToUsd,
              fxRateConfirmed,
              fxRateDate,
              ledgerAccountId: charge.ledgerAccountId ? parseInt(charge.ledgerAccountId) : null,
              supplierId: charge.supplierId ? parseInt(charge.supplierId) : null,
            },
            accountingCtx,
          });

          lastResult = mutResult;
          if (mutResult.cascadeResult) allCascadeResults.push(mutResult.cascadeResult);
        }
      });

      const cascadeResult = allCascadeResults[allCascadeResults.length - 1] || null;
      const r = lastResult!;

      // Fetch updated raw-stock row for response
      const [newRawStock] = await db
        .select()
        .from(factoryRawStock)
        .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)));

      res.json({
        message: "Post-offload charges added and costs recalculated",
        containerId,
        oldContainerCostPerKgUsd,
        newContainerCostPerKgUsd: r.newContainerCostPerKgUsd,
        oldContainerTotalUsd,
        newContainerTotalUsd: parseFloat(
          String(
            (
              await db
                .select({ v: factoryContainers.finalPayableAmountUsd })
                .from(factoryContainers)
                .where(eq(factoryContainers.id, containerId))
            )[0]?.v || "0"
          )
        ),
        rawStockRowsUpdated: cascadeResult?.rawStockRowsUpdated ?? 0,
        supplierLockedRateOld: r.supplierLockedRateBefore ? parseFloat(r.supplierLockedRateBefore) : null,
        supplierLockedRateNew: r.supplierLockedRateAfter ? parseFloat(r.supplierLockedRateAfter) : null,
        supplierRemainingKg: r.supplierRemainingKg,
        containerReceivedKg: r.containerReceivedKg,
        containerRemainingKg: r.containerRemainingKg,
        remainingFraction: parseFloat(r.remainingFraction),
        fullContainerValueDeltaUsd: r.fullContainerValueDeltaUsd,
        supplierInventoryValueDeltaUsd: r.supplierInventoryValueDeltaUsd,
        supplierValueBeforeUsd: r.supplierValueBeforeUsd,
        supplierValueAfterUsd: r.supplierValueAfterUsd,
        supplierLockedRateOldExact: r.supplierLockedRateBefore,
        supplierLockedRateNewExact: r.supplierLockedRateAfter,
        rawStockRateWasStale: false,
        affectedBatches: (cascadeResult?.affectedBatches ?? []).map((b) => ({
          batchId: b.batchId,
          batchCode: b.batchCode,
          status: b.status ?? null,
          wasCompleted: b.wasCompleted,
          weightKgFromContainer: b.weightKgFromContainer,
          oldCostPerKg: b.oldCostPerKg,
          newCostPerKg: b.newCostPerKg,
        })),
        affectedBalesCount: cascadeResult?.affectedBales?.length ?? 0,
        rawStock: newRawStock,
      });
    } catch (error: unknown) {
      logger.error("Error adding post-offload charges:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── GET /api/factory/containers/:id/post-offload-charges ─────────────────────
  // Returns charge history (active + undone) for a container, newest first.
  app.get("/api/factory/containers/:id/post-offload-charges", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });

      const rows = await db
        .select()
        .from(factoryOffloadAdditionalCharges)
        .where(
          and(
            eq(factoryOffloadAdditionalCharges.containerId, containerId),
            eq(factoryOffloadAdditionalCharges.companyId, companyId)
          )
        )
        .orderBy(desc(factoryOffloadAdditionalCharges.createdAt));

      res.json(rows);
    } catch (error: unknown) {
      logger.error("Error fetching post-offload charge history:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── PATCH /api/factory/containers/:id/post-offload-charges/:chargeId ─────────
  // Edit an existing charge in-place. Admin only.
  app.patch(
    "/api/factory/containers/:id/post-offload-charges/:chargeId",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const containerId = parseId(req.params.id);
        const chargeId = parseId(req.params.chargeId);
        if (containerId === null || chargeId === null) return res.status(400).json({ message: "Invalid id" });

        const {
          description,
          amount,
          currencyCode,
          ledgerAccountId,
          supplierId,
          txDate: reqTxDate,
          expectedVersion,
          legacyBaselineRate,
        } = req.body;

        if (!amount || parseFloat(amount) <= 0) {
          return res.status(400).json({ message: "amount must be > 0" });
        }

        const [container] = await db
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
        if (!container) return res.status(404).json({ message: "Container not found" });

        const txDate = reqTxDate || getClientDate(req);
        const containerCcy = container.currencyCode || "USD";
        const chargeCcy = currencyCode || "USD";
        const { fxRate: containerFxRate, looksSet: pocFxLooksSet } = resolveStoredFxRate(
          containerCcy,
          container.fxRateToUsdOffload || container.fxRateToUsd,
          container.fxRateConfirmed
        );
        if (!pocFxLooksSet) {
          return res.status(400).json({ message: new UnresolvedExchangeRateError(containerCcy).message });
        }

        // Resolve FX + accounting context before transaction
        let fxResolved: { fxRateToUsd: number; fxRateConfirmed: boolean; fxRateDate: string };
        try {
          fxResolved = await resolvePostOffloadChargeFx({
            chargeCcy,
            containerCcy,
            containerFxRate,
            containerFxRateDateOffload: container.fxRateDateOffload || null,
            containerFxConfirmed: !!container.fxRateConfirmed,
            txDate,
            companyId,
          });
        } catch (e: unknown) {
          return res.status(400).json({ message: getErrorMessage(e) });
        }

        let acctCtx: AccountingContext = { voucherCompanyId: companyId, chargesPayableAcctId: 0 };
        if (ledgerAccountId) {
          const lid = parseInt(ledgerAccountId);
          const [acctRow] = await db
            .select({ companyId: ledgerAccounts.companyId })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.id, lid));
          const voucherCompanyId = acctRow?.companyId ?? companyId;
          const cpAcctId = await getOrCreateLedgerAccount(
            voucherCompanyId,
            "FACTORY_CHARGES_PAYABLE",
            "Factory Charges Payable"
          );
          acctCtx = { voucherCompanyId, chargesPayableAcctId: cpAcctId };
        } else if (supplierId) {
          const cpAcctId = await getOrCreateLedgerAccount(
            companyId,
            "FACTORY_CHARGES_PAYABLE",
            "Factory Charges Payable"
          );
          acctCtx = { voucherCompanyId: companyId, chargesPayableAcctId: cpAcctId };
        }

        const userId = String(req.session.userId || req.user?.id || "system");
        // Assigned inside the transaction callback, so TypeScript cannot see the
        // assignment: declared optional and asserted once after the await instead
        // of typed `any`.
        let mutResult: PostOffloadMutationResult | undefined;

        try {
          await db.transaction(async (tx) => {
            mutResult = await applyPostOffloadChargeMutation(tx, {
              action: "EDIT",
              companyId,
              containerId,
              chargeId,
              txDate,
              userId,
              expectedVersion: expectedVersion !== undefined ? parseInt(expectedVersion) : undefined,
              legacyBaselineRate: legacyBaselineRate !== undefined ? parseFloat(legacyBaselineRate) : undefined,
              chargeData: {
                description: description || "Post-offload charge",
                amount: parseFloat(amount),
                currencyCode: chargeCcy,
                fxRateToUsd: fxResolved.fxRateToUsd,
                fxRateConfirmed: fxResolved.fxRateConfirmed,
                fxRateDate: fxResolved.fxRateDate,
                ledgerAccountId: ledgerAccountId ? parseInt(ledgerAccountId) : null,
                supplierId: supplierId ? parseInt(supplierId) : null,
              },
              accountingCtx: acctCtx,
            });
          });
        } catch (err: unknown) {
          if ((err as { status?: number }).status === 409)
            return res.status(409).json({ message: getErrorMessage(err) });
          throw err;
        }
        // Unreachable: db.transaction either assigns mutResult or rejects into
        // the catch above. The check exists so the result is non-optional below.
        if (!mutResult) throw new Error("Post-offload charge mutation returned no result");

        res.json({
          message: "Post-offload charge updated",
          ...mutResult,
          supplierLockedRateOldExact: mutResult.supplierLockedRateBefore,
          supplierLockedRateNewExact: mutResult.supplierLockedRateAfter,
          affectedBatches: (mutResult.cascadeResult?.affectedBatches ?? []).map((b) => ({
            batchId: b.batchId,
            batchCode: b.batchCode,
            status: b.status ?? null,
            wasCompleted: b.wasCompleted,
            weightKgFromContainer: b.weightKgFromContainer,
            oldCostPerKg: b.oldCostPerKg,
            newCostPerKg: b.newCostPerKg,
          })),
          affectedBalesCount: mutResult.cascadeResult?.affectedBales?.length ?? 0,
          rawStockRowsUpdated: mutResult.cascadeResult?.rawStockRowsUpdated ?? 0,
        });
      } catch (error: unknown) {
        logger.error("Error editing post-offload charge:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── DELETE /api/factory/containers/:id/post-offload-charges/:chargeId ────────
  // Undo (soft-delete) a charge and reverse accounting. Admin only.
  app.delete(
    "/api/factory/containers/:id/post-offload-charges/:chargeId",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const containerId = parseId(req.params.id);
        const chargeId = parseId(req.params.chargeId);
        if (containerId === null || chargeId === null) return res.status(400).json({ message: "Invalid id" });

        const { expectedVersion, undoDate, legacyBaselineRate } = req.body || {};

        const [container] = await db
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
        if (!container) return res.status(404).json({ message: "Container not found" });

        const txDate = undoDate || getClientDate(req);
        const userId = String(req.session.userId || req.user?.id || "system");
        // Assigned inside the transaction callback, so TypeScript cannot see the
        // assignment: declared optional and asserted once after the await instead
        // of typed `any`.
        let mutResult: PostOffloadMutationResult | undefined;

        try {
          await db.transaction(async (tx) => {
            mutResult = await applyPostOffloadChargeMutation(tx, {
              action: "UNDO",
              companyId,
              containerId,
              chargeId,
              txDate,
              userId,
              expectedVersion: expectedVersion !== undefined ? parseInt(expectedVersion) : undefined,
              legacyBaselineRate: legacyBaselineRate !== undefined ? parseFloat(legacyBaselineRate) : undefined,
            });
          });
        } catch (err: unknown) {
          if ((err as { status?: number }).status === 409)
            return res.status(409).json({ message: getErrorMessage(err) });
          throw err;
        }
        // Unreachable: db.transaction either assigns mutResult or rejects into
        // the catch above. The check exists so the result is non-optional below.
        if (!mutResult) throw new Error("Post-offload charge mutation returned no result");

        if (mutResult.alreadyUndone) {
          return res.json({ message: "Charge was already undone", alreadyUndone: true, chargeId });
        }

        res.json({
          message: "Post-offload charge undone and accounting reversed",
          ...mutResult,
          supplierLockedRateOldExact: mutResult.supplierLockedRateBefore,
          supplierLockedRateNewExact: mutResult.supplierLockedRateAfter,
          affectedBatches: (mutResult.cascadeResult?.affectedBatches ?? []).map((b) => ({
            batchId: b.batchId,
            batchCode: b.batchCode,
            status: b.status ?? null,
            wasCompleted: b.wasCompleted,
            weightKgFromContainer: b.weightKgFromContainer,
            oldCostPerKg: b.oldCostPerKg,
            newCostPerKg: b.newCostPerKg,
          })),
          affectedBalesCount: mutResult.cascadeResult?.affectedBales?.length ?? 0,
          rawStockRowsUpdated: mutResult.cascadeResult?.rawStockRowsUpdated ?? 0,
        });
      } catch (error: unknown) {
        logger.error("Error undoing post-offload charge:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── PATCH /api/factory/containers/:id/post-offload-charges/:chargeId/legacy-rebuild
  // Rebuild supplier rate for a legacy charge (supplierLockedRateBefore IS NULL). Admin only.
  app.patch(
    "/api/factory/containers/:id/post-offload-charges/:chargeId/legacy-rebuild",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const containerId = parseId(req.params.id);
        const chargeId = parseId(req.params.chargeId);
        if (containerId === null || chargeId === null) return res.status(400).json({ message: "Invalid id" });

        const { legacyBaselineRate, expectedVersion } = req.body || {};
        if (!legacyBaselineRate || parseFloat(legacyBaselineRate) <= 0) {
          return res.status(400).json({ message: "legacyBaselineRate is required and must be > 0" });
        }

        const [container] = await db
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
        if (!container) return res.status(404).json({ message: "Container not found" });

        const userId = String(req.session.userId || req.user?.id || "system");
        // Assigned inside the transaction callback, so TypeScript cannot see the
        // assignment: declared optional and asserted once after the await instead
        // of typed `any`.
        let mutResult: PostOffloadMutationResult | undefined;

        try {
          await db.transaction(async (tx) => {
            mutResult = await applyPostOffloadChargeMutation(tx, {
              action: "LEGACY_REBUILD",
              companyId,
              containerId,
              chargeId,
              txDate: getClientDate(req),
              userId,
              legacyBaselineRate: parseFloat(legacyBaselineRate),
              expectedVersion: expectedVersion !== undefined ? parseInt(expectedVersion) : undefined,
            });
          });
        } catch (err: unknown) {
          if ((err as { status?: number }).status === 409)
            return res.status(409).json({ message: getErrorMessage(err) });
          throw err;
        }
        // Unreachable: db.transaction either assigns mutResult or rejects into
        // the catch above. The check exists so the result is non-optional below.
        if (!mutResult) throw new Error("Post-offload charge mutation returned no result");

        res.json({
          message: "Legacy charge supplier rate rebuilt successfully",
          ...mutResult,
          supplierLockedRateOldExact: mutResult.supplierLockedRateBefore,
          supplierLockedRateNewExact: mutResult.supplierLockedRateAfter,
        });
      } catch (error: unknown) {
        logger.error("Error rebuilding legacy post-offload charge:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/factory/containers/:id/duty-audit-log", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const logs = await db
        .select()
        .from(factoryDutyAuditLog)
        .where(and(eq(factoryDutyAuditLog.companyId, companyId), eq(factoryDutyAuditLog.containerId, containerId)))
        .orderBy(desc(factoryDutyAuditLog.createdAt));

      res.json(logs);
    } catch (error: unknown) {
      logger.error("Error fetching duty audit log:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/container-commissions/:containerId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const containerId = parseId(req.params.containerId);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const results = await db
        .select()
        .from(factoryContainerCommissions)
        .where(
          and(
            eq(factoryContainerCommissions.companyId, companyId),
            eq(factoryContainerCommissions.containerId, containerId)
          )
        );

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching commissions:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
