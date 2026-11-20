// Extracted from ./rawStockContainerRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../../../lib/parseId";
import { toMoney } from "../../../lib/money";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { type AccountingContext, applyPostOffloadChargeMutation } from "../../../services/factory/post-offload-charge";
import type { CascadeResult } from "../../../services/factory/rawStockCostCascade";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../../services/factory/currencyConversion";
import { getOrCreateLedgerAccount } from "../_helpers";
import { FactoryFxRateRequiredError } from "../../../services/factory/factoryDocumentFxRate";
import { factoryContainers, factoryOffloadAdditionalCharges, factoryRawStock, ledgerAccounts } from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { positiveRequestAmount, resolvePostOffloadChargeFx } from "./registerRawStockContainerRoutesPart1";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { createPostOffloadChargesInput } from "./containerChargeRouteSchemas";

export function registerRawStockContainerRoutesPart2(app: Express) {
  // ── Post-offload charges: add duties/charges after a container has been offloaded ──
  app.post(
    "/api/factory/containers/:id/post-offload-charges",
    requireAuth,
    validateRequest(createPostOffloadChargesInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const containerId = validatedInput(req, createPostOffloadChargesInput).params.id;

        const { charges, txDate: reqTxDate } = req.body;
        if (!Array.isArray(charges) || charges.length === 0) {
          return res.status(400).json({ message: "At least one charge is required" });
        }

        const validCharges = charges.filter((c) => positiveRequestAmount(c.amount));
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
        if (toMoney(container.actualReceivedKg).lessThanOrEqualTo(0)) {
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
            if (e instanceof FactoryFxRateRequiredError) return res.status(409).json(e.body);
            return res.status(400).json({ message: getErrorMessage(e) });
          }

          if (Number(Boolean(charge.ledgerAccountId)) + Number(Boolean(charge.supplierId)) !== 1) {
            return res.status(400).json({
              message: "Each post-offload charge needs exactly one ledger account or supplier before it can be saved.",
            });
          }
          let acctCtx: AccountingContext = { voucherCompanyId: companyId, chargesPayableAcctId: 0 };
          if (charge.ledgerAccountId) {
            const lid = parseInt(charge.ledgerAccountId);
            const [acctRow] = await db
              .select({ companyId: ledgerAccounts.companyId })
              .from(ledgerAccounts)
              .where(eq(ledgerAccounts.id, lid));
            if (acctRow?.companyId !== companyId) {
              return res.status(400).json({ message: "Charge ledger account must belong to the selected company." });
            }
            const voucherCompanyId = companyId;
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

        const oldContainerCostPerKgUsd = toMoney(container.ratePerKgUsd).toNumber();
        const oldContainerTotalUsd = toMoney(container.finalPayableAmountUsd).toNumber();

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
                amount: positiveRequestAmount(charge.amount)!.toNumber(),
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
          newContainerTotalUsd: toMoney(
            String(
              (
                await db
                  .select({ v: factoryContainers.finalPayableAmountUsd })
                  .from(factoryContainers)
                  .where(eq(factoryContainers.id, containerId))
              )[0]?.v || "0"
            )
          ).toNumber(),
          rawStockRowsUpdated: cascadeResult?.rawStockRowsUpdated ?? 0,
          supplierLockedRateOld: r.supplierLockedRateBefore ? toMoney(r.supplierLockedRateBefore).toNumber() : null,
          supplierLockedRateNew: r.supplierLockedRateAfter ? toMoney(r.supplierLockedRateAfter).toNumber() : null,
          supplierRemainingKg: r.supplierRemainingKg,
          containerReceivedKg: r.containerReceivedKg,
          containerRemainingKg: r.containerRemainingKg,
          remainingFraction: toMoney(r.remainingFraction).toNumber(),
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
    }
  );

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
}
