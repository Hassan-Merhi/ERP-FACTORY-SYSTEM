/**
 * factoryContainersRoutes: FactoryContainerUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { FactoryFxRateRequiredError } from "../../../services/factory/factoryDocumentFxRate";
import { factorySuppliers, factoryDaybookEntries } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { sendVoucherCorrectionRefusal } from "../../../services/factory/factoryVoucherCorrection";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import { toMoney } from "../../../lib/money";
import { prepareFactoryContainerUpdate } from "./updateInput";
import { planFactoryContainerUpdateSync } from "./updateSyncPlan";
import { applyFactoryContainerUpdateTx } from "./updateTransaction";
import { z } from "zod";
import { emptyQuery, idParams, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";

// prepareFactoryContainerUpdate (./updateInput.ts) whitelists these keys and
// coerces each with String/parseInt, so values may be strings or numbers.
const scalar = z.union([z.string(), z.number()]).nullable().optional();
const updateContainerInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({
    containerNumber: scalar,
    supplierId: scalar,
    origin: scalar,
    totalKg: scalar,
    ratePerKg: scalar,
    arrivalDate: scalar,
    destination: scalar,
    notes: scalar,
    status: scalar,
    currencyCode: scalar,
    fxRateSource: scalar,
    fxRateToUsd: scalar,
    freight: scalar,
    freightCurrencyCode: scalar,
    freightAccountId: scalar,
    freightSupplierId: scalar,
    freightPaidBy: scalar,
    freightOwnAccountId: scalar,
    otherCharges: scalar,
    otherChargesCurrencyCode: scalar,
    otherChargesAccountId: scalar,
    otherChargesSupplierId: scalar,
    commissionAmount: scalar,
    commissionCurrencyCode: scalar,
    commissionAccountId: scalar,
    commissionSupplierId: scalar,
    commissionNotes: scalar,
    dutyAmount: scalar,
    dutyAccountId: scalar,
    dutyStatus: scalar,
    dutyNotes: scalar,
    otwNote: scalar,
    otwDocsReceived: z.boolean().nullable().optional(),
  }),
} satisfies RequestSchemas;

export function registerFactoryContainerUpdateRoutes(app: Express) {
  app.patch(
    "/api/factory/containers/:id",
    requireAuth,
    validateRequest(updateContainerInput),
    async (req: Request, res: Response) => {
      const _t = Date.now();
      const _uid = req.session.userId;
      const _cid = req.session.factoryCompanyId || req.session.currentCompanyId;
      try {
        logger.info("factory container update started", {
          module: "factoryContainers",
          action: "update",
          userId: _uid,
          companyId: _cid,
        });
        const input = await prepareFactoryContainerUpdate({ req, res });
        if (input.done) return input.value;
        const { updateData, companyId, id } = input;
        const plan = await planFactoryContainerUpdateSync({ input, res });
        if (plan.done) return plan.value;

        // The container row, its freight voucher and its commission journal are
        // written in one transaction.
        const updated = await db.transaction(async (tx) => {
          return await applyFactoryContainerUpdateTx({ tx, input, plan, req });
        });

        if (!updated) return res.status(404).json({ message: "Container not found" });

        // ── Sync CONTAINER_IMPORT daybook entry ────────────────────────────────
        // If any description-relevant fields were changed (container number, supplier,
        // quantity, rate, currency, arrival date), update the stored daybook entry so
        // the daybook always shows current data without requiring a separate migration.
        const descRelevantFields = [
          "containerNumber",
          "supplierId",
          "totalKg",
          "ratePerKg",
          "currencyCode",
          "arrivalDate",
        ];
        const touchedDescField = descRelevantFields.some((f) => f in updateData);
        if (touchedDescField) {
          let supplierNameForSync = "";
          if (updated.supplierId) {
            const [sup] = await db
              .select({ name: factorySuppliers.name })
              .from(factorySuppliers)
              .where(eq(factorySuppliers.id, updated.supplierId));
            supplierNameForSync = sup?.name || "";
          }
          const kgExact = toMoney(updated.totalKg);
          const rateExact = toMoney(updated.ratePerKg);
          const kgForSync = kgExact.toNumber();
          const rateForSync = rateExact.toNumber();
          const ccyForSync = updated.currencyCode || "USD";
          const syncDescParts = [
            updated.containerNumber,
            supplierNameForSync,
            kgForSync > 0 ? `${kgForSync.toLocaleString()} kg` : null,
            rateForSync > 0 ? `${rateForSync} ${ccyForSync}/kg` : null,
          ].filter(Boolean);
          const syncDesc = syncDescParts.join(" · ");
          const syncAmount = rateExact.times(kgExact);
          const storedFx = toMoney(updated.fxRateToUsd);
          const syncFxRate = storedFx.isZero() ? toMoney(1) : storedFx;
          const daybookUpdateSet: Partial<typeof factoryDaybookEntries.$inferInsert> = { description: syncDesc };
          if (syncAmount.greaterThan(0)) {
            daybookUpdateSet.amountCurrency = syncAmount.toFixed();
            daybookUpdateSet.amountUsd = syncAmount.times(syncFxRate).toFixed();
          }
          if ("arrivalDate" in updateData && updated.arrivalDate) {
            daybookUpdateSet.txDate = updated.arrivalDate;
          }
          await db
            .update(factoryDaybookEntries)
            .set(daybookUpdateSet)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "CONTAINER_IMPORT"),
                eq(factoryDaybookEntries.referenceId, id)
              )
            );
        }

        logger.info("factory container update succeeded", {
          module: "factoryContainers",
          action: "update",
          userId: _uid,
          companyId: _cid,
          containerId: id,
          durationMs: Date.now() - _t,
        });
        res.json(updated);
      } catch (error: unknown) {
        if (error instanceof FactoryFxRateRequiredError) return res.status(409).json(error.body);
        if (sendVoucherCorrectionRefusal(res, error)) return;
        const closed = closedPeriodErrorResponse(error);
        if (closed) return res.status(closed.status).json(closed.body);
        logger.error("factory container update failed", {
          module: "factoryContainers",
          action: "update",
          userId: _uid,
          companyId: _cid,
          durationMs: Date.now() - _t,
          error,
        });
        const pgErr = (error as { cause?: unknown }).cause ?? error;
        const pgMsg = getErrorMessage(pgErr) ?? getErrorMessage(error) ?? "Unknown error";
        const pgCode = (pgErr as { code?: string }).code;
        const pgConstraint = (pgErr as { constraint?: string }).constraint;
        logger.error("[factory-container PATCH] DB error:", {
          pgCode,
          pgConstraint,
          pgMsg,
          full: getErrorMessage(error),
        });
        const userMsg = pgCode
          ? `${pgMsg}${pgConstraint ? ` (constraint: ${pgConstraint})` : ""}`
          : pgMsg.split("\n\n").pop() || pgMsg;
        res.status(400).json({ message: userMsg });
      }
    }
  );
}
