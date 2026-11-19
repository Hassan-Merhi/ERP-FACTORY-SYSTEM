// Extracted from ./daybookEditRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { asRecord, isNonEmptyString, toPositiveInteger } from "@shared/typeGuards";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import { emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import { recalculateContainerCosts } from "../_helpers";
import { resolveStoredFxRate, UnresolvedExchangeRateError } from "../../../services/factory/currencyConversion";
import {
  factoryContainerCommissions,
  factoryContainers,
  factoryDaybookEntries,
  factoryDaybookEntryEdits,
  factoryDutyAuditLog,
  factoryOffloadAdditionalCharges,
  factoryRawStock,
  factorySuppliers,
} from "@shared/schema";
import { and, eq } from "drizzle-orm";
import type Decimal from "decimal.js";
import { parseMoneyInput, toMoney } from "../../../lib/money";
import { syncContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";

// The handler checks the reason, amount and rate itself (parseMoneyInput).
const numeric = z.union([z.string(), z.number()]);
const costEditInput = {
  params: z.strictObject({ entryId: stringParam }),
  query: emptyQuery,
  body: z.strictObject({
    newAmount: numeric.optional(),
    reason: z.string().optional(),
    newCurrencyCode: z.string().nullable().optional(),
    newFxRate: numeric.nullable().optional(),
  }),
} satisfies RequestSchemas;

export function registerFactoryDaybookEditRoutesPart2(app: Express) {
  // PATCH /api/factory/daybook/:entryId/cost-edit — Edit a container cost entry and cascade changes
  // Supports: OFFLOAD_RAW_STOCK, FREIGHT, COMMISSION, DUTY, OTHER_CHARGE
  // Restricted to admin/owner/developer. Triggers full container cost recalculation.
  app.patch(
    "/api/factory/daybook/:entryId/cost-edit",
    requireAuth,
    validateRequest(costEditInput),
    async (req: Request, res: Response) => {
      try {
        const session = req.session;
        const companyId = session.factoryCompanyId || session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const userId = session.userId ?? null;

        const currentRole = (session.currentRole || session.role || "").toLowerCase();
        if (!["admin", "owner", "developer"].includes(currentRole)) {
          return res.status(403).json({ message: "Only Admin/Owner/Developer can edit container cost entries" });
        }

        const entryId = Number(req.params.entryId);
        if (isNaN(entryId) || entryId <= 0) return res.status(400).json({ message: "Invalid entry ID" });

        const { newAmount, reason, newCurrencyCode, newFxRate } = req.body;
        if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
          return res.status(400).json({ message: "Edit reason is required" });
        }
        // Read the way parseFloat reads it, so the accepted input is unchanged.
        const parsedAmount = parseMoneyInput(newAmount);
        if (!parsedAmount || parsedAmount.lessThan(0)) {
          return res.status(400).json({ message: "newAmount must be a non-negative number" });
        }
        // A supplied rate that does not parse used to make the entry's USD amount NaN.
        const requestFx = newFxRate ? parseMoneyInput(String(newFxRate)) : null;
        if (newFxRate && !requestFx) return res.status(400).json({ message: "Invalid amount" });
        // The amount as the source columns receive it: the same text the float path wrote.
        const amountText = parsedAmount.toFixed();

        const COST_TX_TYPES = ["OFFLOAD_RAW_STOCK", "FREIGHT", "COMMISSION", "DUTY", "OTHER_CHARGE"];

        const [entry] = await db
          .select()
          .from(factoryDaybookEntries)
          .where(and(eq(factoryDaybookEntries.id, entryId), eq(factoryDaybookEntries.companyId, companyId)));
        if (!entry) return res.status(404).json({ message: "Daybook entry not found" });
        if (!COST_TX_TYPES.includes(entry.txType)) {
          return res
            .status(400)
            .json({ message: `txType '${entry.txType}' is not a cost entry — use the standard edit endpoint` });
        }

        // Parse metaJson to determine exact source
        // metaJson is free-form persisted JSON, so it stays `unknown` until each
        // field below is coerced; asRecord keeps a non-object payload from
        // becoming property reads on a string or array.
        let meta: Record<string, unknown> = {};
        try {
          meta = asRecord(JSON.parse(entry.metaJson || "{}")) ?? {};
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }

        // Resolve containerId from metaJson or txType + referenceId fallback
        let containerId: number | null = toPositiveInteger(meta.containerId) ?? null;
        if (!containerId) {
          if (entry.txType === "FREIGHT" || entry.txType === "DUTY" || entry.txType === "OTHER_CHARGE") {
            containerId = entry.referenceId;
          } else if (entry.txType === "OFFLOAD_RAW_STOCK") {
            // referenceId = rawStock.id; look up containerId from rawStock
            const [rs] = await db
              .select({ containerId: factoryRawStock.containerId })
              .from(factoryRawStock)
              .where(eq(factoryRawStock.id, entry.referenceId!));
            containerId = rs?.containerId ?? null;
          } else if (entry.txType === "COMMISSION") {
            // referenceId = commissionRecord.id; look up containerId from commission
            const [comm] = await db
              .select({ containerId: factoryContainerCommissions.containerId })
              .from(factoryContainerCommissions)
              .where(eq(factoryContainerCommissions.id, entry.referenceId!));
            containerId = comm?.containerId ?? null;
          }
        }
        if (!containerId) return res.status(400).json({ message: "Cannot resolve container from this daybook entry" });

        const [container] = await db
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.id, containerId), eq(factoryContainers.companyId, companyId)));
        if (!container) return res.status(404).json({ message: "Container not found" });

        const [materialSupplier] = container.supplierId
          ? await db
              .select({ name: factorySuppliers.name })
              .from(factorySuppliers)
              .where(and(eq(factorySuppliers.id, container.supplierId), eq(factorySuppliers.companyId, companyId)))
          : [];
        const supplierNarrationSuffix = materialSupplier?.name?.trim() ? ` - ${materialSupplier.name.trim()}` : "";

        const beforeJson = JSON.stringify(entry);
        const sourceType: string = isNonEmptyString(meta.sourceType) ? meta.sourceType : entry.txType;

        await db.transaction(async (tx) => {
          // ── 1. Update the specific source record ────────────────────────────────
          if (sourceType === "BASE_MATERIAL" || entry.txType === "OFFLOAD_RAW_STOCK") {
            // Editing base material cost: derive new ratePerKg from amount / actualKg
            const actualKg = toMoney(container.actualReceivedKg);
            if (actualKg.lessThanOrEqualTo(0)) throw new Error("Container has no received weight");
            const newRate = parsedAmount.dividedBy(actualKg);
            const ccy = newCurrencyCode || container.currencyCode || "USD";
            await tx
              .update(factoryContainers)
              .set({ ratePerKg: newRate.toFixed(6), currencyCode: ccy, updatedAt: new Date() })
              .where(eq(factoryContainers.id, containerId!));
          } else if (sourceType === "FREIGHT" || entry.txType === "FREIGHT") {
            const ccy =
              newCurrencyCode ||
              (container as { freightCurrencyCode: unknown }).freightCurrencyCode ||
              container.currencyCode ||
              "USD";
            let fx: string;
            if (requestFx) {
              fx = requestFx.toFixed(); // fresh explicit request input — trust it even if it equals 1
            } else {
              const fallbackRaw = container.fxRateToUsdOffload || container.fxRateToUsd;
              const { fxRate: resolvedFx, looksSet } = resolveStoredFxRate(ccy, fallbackRaw, container.fxRateConfirmed);
              if (!looksSet) throw new UnresolvedExchangeRateError(ccy);
              fx = String(resolvedFx);
            }
            await tx
              .update(factoryContainers)
              .set({ freight: amountText, updatedAt: new Date() })
              .where(eq(factoryContainers.id, containerId!));
            // Also update the daybook entry currency if it changed
            if (newCurrencyCode) {
              await tx
                .update(factoryDaybookEntries)
                .set({ currencyCode: ccy, fxRateToUsd: fx })
                .where(eq(factoryDaybookEntries.id, entryId));
            }
          } else if (sourceType === "COMMISSION" || entry.txType === "COMMISSION") {
            const commId = toPositiveInteger(meta.commissionId) ?? entry.referenceId;
            if (commId) {
              await tx
                .update(factoryContainerCommissions)
                .set({ commissionTotal: amountText })
                .where(
                  and(eq(factoryContainerCommissions.id, commId), eq(factoryContainerCommissions.companyId, companyId))
                );
            }
            // Also sync the commissionAmount summary on the container
            await tx
              .update(factoryContainers)
              .set({ commissionAmount: amountText, updatedAt: new Date() })
              .where(eq(factoryContainers.id, containerId!));
            // Wave 8.4 continuation: and its commission journal FACTORY-COMM-{container}.
            await syncContainerCommissionJournalTx(tx, companyId, containerId!);
          } else if (sourceType === "DUTY" || entry.txType === "DUTY") {
            if (container.dutyStatus !== "CONFIRMED") {
              throw new Error(
                "Duty can only be edited when its status is CONFIRMED. Use the confirm-duty flow for PENDING duty."
              );
            }
            const oldDuty = container.dutyAmount;
            await tx
              .update(factoryContainers)
              .set({ dutyAmount: amountText, updatedAt: new Date() })
              .where(eq(factoryContainers.id, containerId!));
            // Write duty audit log
            await tx.insert(factoryDutyAuditLog).values({
              companyId,
              containerId,
              oldDutyAmount: oldDuty || "0",
              newDutyAmount: amountText,
              oldDutyStatus: "CONFIRMED",
              newDutyStatus: "CONFIRMED",
              notes: `Edited via daybook cost-edit. Reason: ${reason.trim()}`,
              updatedByUserId: String(userId || "system"),
            });
          } else if (sourceType === "CONTAINER_OC") {
            await tx
              .update(factoryContainers)
              .set({ otherCharges: amountText, updatedAt: new Date() })
              .where(eq(factoryContainers.id, containerId!));
          } else if (sourceType === "OFFLOAD_ADDITIONAL" || sourceType === "POST_OFFLOAD_ADDITIONAL") {
            const chargeId = toPositiveInteger(meta.chargeId) ?? null;
            if (!chargeId) throw new Error("Missing chargeId in metaJson — cannot update individual additional charge");
            await tx
              .update(factoryOffloadAdditionalCharges)
              .set({ amount: amountText })
              .where(
                and(
                  eq(factoryOffloadAdditionalCharges.id, chargeId),
                  eq(factoryOffloadAdditionalCharges.companyId, companyId)
                )
              );
          } else {
            // Legacy fallback for entries with no metaJson — infer from txType
            if (entry.txType === "OTHER_CHARGE") {
              await tx
                .update(factoryContainers)
                .set({ otherCharges: amountText, updatedAt: new Date() })
                .where(eq(factoryContainers.id, containerId!));
            }
          }

          // ── 2. Cascade recalculation ─────────────────────────────────────────────
          const { totalCost, inclusiveCostPerKg } = await recalculateContainerCosts(tx, companyId, containerId!);

          // ── 3. Update THIS daybook entry amount ──────────────────────────────────
          const entryCcy = newCurrencyCode || entry.currencyCode || "USD";
          let fx: Decimal;
          if (requestFx) {
            fx = requestFx; // fresh explicit request input — trust it even if it equals 1
          } else {
            // factory_daybook_entries has no fxRateConfirmed column yet, so this still relies on
            // the legacy value-based heuristic (rate>0 && rate!==1) as a stopgap — a genuine
            // confirmed 1.0 rate stored directly on a daybook entry would be misflagged here.
            const { fxRate: resolvedFx, looksSet } = resolveStoredFxRate(entryCcy, entry.fxRateToUsd);
            if (!looksSet) throw new UnresolvedExchangeRateError(entryCcy);
            fx = toMoney(resolvedFx);
          }
          const amtUsd = entryCcy === "USD" ? parsedAmount : parsedAmount.times(fx);
          const updatedMetaJson = JSON.stringify({ ...meta, containerId, sourceType });
          await tx
            .update(factoryDaybookEntries)
            .set({ amountCurrency: parsedAmount.toFixed(2), amountUsd: amtUsd.toFixed(2), metaJson: updatedMetaJson })
            .where(eq(factoryDaybookEntries.id, entryId));

          // ── 4. Sync OFFLOAD_RAW_STOCK daybook entry (total inclusive cost) ────────
          // This entry always shows the total cost of the container
          if (entry.txType !== "OFFLOAD_RAW_STOCK") {
            const [rawStockRow] = await tx
              .select({ id: factoryRawStock.id })
              .from(factoryRawStock)
              .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId!)));
            if (rawStockRow) {
              const containerCcy = container.currencyCode || "USD";
              const { fxRate: containerFx, looksSet: containerFxLooksSet } = resolveStoredFxRate(
                containerCcy,
                container.fxRateToUsd,
                (container as { fxRateConfirmed: boolean | undefined }).fxRateConfirmed
              );
              if (!containerFxLooksSet) throw new UnresolvedExchangeRateError(containerCcy);
              const totalCostExact = toMoney(totalCost);
              const totalUsd = containerCcy === "USD" ? totalCostExact : totalCostExact.times(toMoney(containerFx));
              // Rounded once to the cents the columns keep (a 4-place string was rounded twice).
              await tx
                .update(factoryDaybookEntries)
                .set({
                  amountCurrency: totalCostExact.toFixed(2),
                  amountUsd: totalUsd.toFixed(2),
                  description: `Offloaded container ${container.containerNumber}${supplierNarrationSuffix}: ${container.actualReceivedKg} kg at ${inclusiveCostPerKg.toFixed(4)}/kg (inclusive) [edited]`,
                })
                .where(
                  and(
                    eq(factoryDaybookEntries.companyId, companyId),
                    eq(factoryDaybookEntries.txType, "OFFLOAD_RAW_STOCK"),
                    eq(factoryDaybookEntries.referenceId, rawStockRow.id)
                  )
                );
            }
          }

          // ── 5. Audit record ───────────────────────────────────────────────────────
          await tx.insert(factoryDaybookEntryEdits).values({
            daybookEntryId: entryId,
            editedBy: userId,
            beforeJson,
            afterJson: JSON.stringify({ ...entry, amountCurrency: amountText }),
            reason: reason.trim(),
          });
        });

        // Return updated entry
        const [updated] = await db.select().from(factoryDaybookEntries).where(eq(factoryDaybookEntries.id, entryId));
        const [updatedContainer] = await db
          .select({
            id: factoryContainers.id,
            containerNumber: factoryContainers.containerNumber,
            finalPayableAmount: factoryContainers.finalPayableAmount,
            ratePerKgUsd: factoryContainers.ratePerKgUsd,
          })
          .from(factoryContainers)
          .where(eq(factoryContainers.id, containerId));

        res.json({
          entry: updated,
          container: updatedContainer,
          message: `Cost updated. New inclusive cost: ${updatedContainer?.ratePerKgUsd ?? "?"}/kg`,
        });
      } catch (error: unknown) {
        logger.error("Error in daybook cost-edit:", { error: error });
        const status = (error as { name?: string }).name === "UnresolvedExchangeRateError" ? 400 : 500;
        res.status(status).json({ message: getErrorMessage(error) });
      }
    }
  );
}
