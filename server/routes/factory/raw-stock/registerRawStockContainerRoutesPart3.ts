// Extracted from ./rawStockContainerRoutes.ts to keep that module under the source-size cap.
import { parseMoneyInput } from "../../../lib/money";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import {
  type AccountingContext,
  applyPostOffloadChargeMutation,
  type PostOffloadMutationResult,
} from "../../../services/factory/post-offload-charge";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../../services/factory/currencyConversion";
import { getOrCreateLedgerAccount } from "../_helpers";
import { FactoryFxRateRequiredError } from "../../../services/factory/factoryDocumentFxRate";
import { factoryContainers, ledgerAccounts } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { ADMIN_ROLES, positiveRequestAmount, resolvePostOffloadChargeFx } from "./registerRawStockContainerRoutesPart1";
import { registerRawStockContainerRoutesPart4 } from "./registerRawStockContainerRoutesPart4";
import { validateRequest, validatedInput } from "../../../lib/validateRequest";
import { editPostOffloadChargeInput } from "./containerChargeRouteSchemas";

export function registerRawStockContainerRoutesPart3(app: Express) {
  // ── PATCH /api/factory/containers/:id/post-offload-charges/:chargeId ─────────
  // Edit an existing charge in-place. Admin only.
  app.patch(
    "/api/factory/containers/:id/post-offload-charges/:chargeId",
    requireAuth,
    requireRole(...ADMIN_ROLES),
    validateRequest(editPostOffloadChargeInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const { id: containerId, chargeId } = validatedInput(req, editPostOffloadChargeInput).params;

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

        const amountExact = positiveRequestAmount(amount);
        if (!amountExact) {
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
          if (e instanceof FactoryFxRateRequiredError) return res.status(409).json(e.body);
          return res.status(400).json({ message: getErrorMessage(e) });
        }

        if (Number(Boolean(ledgerAccountId)) + Number(Boolean(supplierId)) !== 1) {
          return res.status(400).json({
            message: "A post-offload charge edit requires exactly one ledger account or supplier.",
          });
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
        // The transaction returns its callback's value, so the result is a plain
        // definitely-assigned local rather than the `any` it used to be.
        let mutResult: PostOffloadMutationResult;

        try {
          mutResult = await db.transaction(async (tx) =>
            applyPostOffloadChargeMutation(tx, {
              action: "EDIT",
              companyId,
              containerId,
              chargeId,
              txDate,
              userId,
              expectedVersion: expectedVersion !== undefined ? parseInt(expectedVersion) : undefined,
              legacyBaselineRate:
                legacyBaselineRate !== undefined ? (parseMoneyInput(legacyBaselineRate)?.toNumber() ?? NaN) : undefined,
              chargeData: {
                description: description || "Post-offload charge",
                amount: amountExact.toNumber(),
                currencyCode: chargeCcy,
                fxRateToUsd: fxResolved.fxRateToUsd,
                fxRateConfirmed: fxResolved.fxRateConfirmed,
                fxRateDate: fxResolved.fxRateDate,
                ledgerAccountId: ledgerAccountId ? parseInt(ledgerAccountId) : null,
                supplierId: supplierId ? parseInt(supplierId) : null,
              },
              accountingCtx: acctCtx,
            })
          );
        } catch (err: unknown) {
          if ((err as { status?: number }).status === 409)
            return res.status(409).json({ message: getErrorMessage(err) });
          throw err;
        }
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

  registerRawStockContainerRoutesPart4(app);
}
