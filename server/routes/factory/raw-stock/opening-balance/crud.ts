/**
 * rawStockBalanceRoutesLegacy: RawStockOpeningBalance endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { getClientDate } from "../../../../lib/dateUtils";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { applyOffloadMovingAverage } from "../../../../services/factory/rawStockLockedRate";
import {
  convertToUsdOrThrow,
  resolveStoredFxRateOrThrow,
  UnresolvedExchangeRateError,
} from "../../../../services/factory/currencyConversion";
import { writeDaybookEntry } from "../../_helpers";
import { factorySuppliers, factoryContainers, factoryRawStock, factoryMixBatchSources } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

export function registerRawStockOpeningBalanceRoutes(app: Express) {
  app.post("/api/factory/raw-stock/opening-balance", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        supplierName,
        supplierId: reqSupplierId,
        receivedKg,
        costPerKg,
        currencyCode: reqCurrency,
        fxRateToUsd: reqFxRate,
        notes,
        commissionAmount: reqCommAmount,
        commissionCurrencyCode: reqCommCurrency,
        commissionFxRateToUsd: reqCommFxRate,
      } = req.body;

      if (!supplierName || !String(supplierName).trim())
        return res.status(400).json({ message: "Supplier name is required" });
      if (!receivedKg || parseFloat(receivedKg) <= 0)
        return res.status(400).json({ message: "Received KG must be positive" });
      if (!costPerKg || parseFloat(costPerKg) < 0)
        return res.status(400).json({ message: "Cost per KG must be non-negative" });

      const currencyCode = reqCurrency || "USD";
      const kgVal = parseFloat(receivedKg);
      const rateVal = parseFloat(costPerKg);
      let costPerKgUsd: number;
      try {
        costPerKgUsd = convertToUsdOrThrow(rateVal, currencyCode, reqFxRate);
      } catch (err: unknown) {
        if (err instanceof UnresolvedExchangeRateError) return res.status(400).json({ message: err.message });
        throw err;
      }
      const fxRate = currencyCode === "USD" ? 1 : parseFloat(reqFxRate);
      const totalPayable = kgVal * rateVal;
      const totalPayableUsd = kgVal * costPerKgUsd;
      const trimmedSupplierName = String(supplierName).trim();

      // Commission is a separate new record on this same write — its non-USD rate must be
      // explicitly supplied too, never silently defaulted to 1 like the main container rate.
      const hasCommissionReq = reqCommAmount && parseFloat(reqCommAmount) > 0;
      const commCurrencyCode = reqCommCurrency || "USD";
      let commFxRateResolved = 1;
      if (hasCommissionReq && commCurrencyCode !== "USD") {
        try {
          commFxRateResolved = resolveStoredFxRateOrThrow(commCurrencyCode, reqCommFxRate);
        } catch (err: unknown) {
          if (err instanceof UnresolvedExchangeRateError)
            return res.status(400).json({ message: `Commission: ${err.message}` });
          throw err;
        }
      }

      const result = await db.transaction(async (tx) => {
        // Use supplierId directly if provided, otherwise find-or-create by name
        let existingSupplier: ({ id: number; companyId: number; name: string; contactPerson: string | null; phone: string | null; email: string | null; address: string | null; notes: string | null; openingBalance: string; linkedSupplierId: number | null; parentId: number | null; supplierCategoryId: number | null; isActive: boolean; isBroker: boolean; currentRawMaterialCostPerKgUsd: string | null; createdAt: Date; updatedAt: Date; }) | ({ name: string; id: number; email: string | null; companyId: number; notes: string | null; createdAt: Date; updatedAt: Date; phone: string | null; openingBalance: string; isActive: boolean; parentId: number | null; address: string | null; contactPerson: string | null; linkedSupplierId: number | null; supplierCategoryId: number | null; isBroker: boolean; currentRawMaterialCostPerKgUsd: string | null; });
        if (reqSupplierId) {
          const [found] = await tx
            .select()
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, parseInt(reqSupplierId)), eq(factorySuppliers.companyId, companyId)))
            .limit(1);
          existingSupplier = found;
          if (!existingSupplier) return res.status(404).json({ message: "Supplier not found" });
        } else {
          const [found] = await tx
            .select()
            .from(factorySuppliers)
            .where(
              and(
                eq(factorySuppliers.companyId, companyId),
                sql`lower(${factorySuppliers.name}) = lower(${trimmedSupplierName})`
              )
            )
            .limit(1);
          if (found) {
            existingSupplier = found;
          } else {
            const [newSupplier] = await tx
              .insert(factorySuppliers)
              .values({ companyId, name: trimmedSupplierName, isActive: true })
              .returning();
            existingSupplier = newSupplier;
          }
        }

        const year = new Date().getFullYear();
        const existingOBs = await tx
          .select({ containerNumber: factoryContainers.containerNumber })
          .from(factoryContainers)
          .where(
            and(
              eq(factoryContainers.companyId, companyId),
              sql`${factoryContainers.containerNumber} LIKE ${"OB-" + year + "-%"}`
            )
          );

        let nextNum = 1;
        for (const c of existingOBs) {
          const parts = c.containerNumber.split("-");
          const num = parseInt(parts[2]) || 0;
          if (num >= nextNum) nextNum = num + 1;
        }
        const containerNumber = `OB-${year}-${String(nextNum).padStart(4, "0")}`;

        const [container] = await tx
          .insert(factoryContainers)
          .values({
            companyId,
            containerNumber,
            supplierId: existingSupplier.id,
            origin: "Opening Balance",
            totalKg: String(kgVal),
            ratePerKg: String(rateVal),
            declaredKg: String(kgVal),
            actualReceivedKg: String(kgVal),
            finalPayableAmount: String(totalPayable),
            differenceKg: "0",
            currencyCode,
            fxRateToUsd: String(fxRate),
            ratePerKgUsd: String(costPerKgUsd),
            finalPayableAmountUsd: String(totalPayableUsd),
            notes: notes || "Opening balance import",
            status: "OPENING_BALANCE",
          })
          .returning();

        // Commission processing — auto-create/reuse "[SupplierName] Commission" sub-account
        const hasCommission = hasCommissionReq;
        const commCurrency = commCurrencyCode;
        const commFxRate = commFxRateResolved;
        const commAmountNum = hasCommission ? parseFloat(reqCommAmount) : 0;
        const commAmountUsd = hasCommission ? (commCurrency === "USD" ? commAmountNum : commAmountNum * commFxRate) : 0;

        let commissionSupplierId: number | null = null;
        if (hasCommission && existingSupplier) {
          const commName = `${existingSupplier.name} Commission`;
          const [existing] = await tx
            .select()
            .from(factorySuppliers)
            .where(
              and(
                eq(factorySuppliers.companyId, companyId),
                eq(factorySuppliers.parentId, existingSupplier.id),
                sql`lower(${factorySuppliers.name}) = lower(${commName})`
              )
            )
            .limit(1);
          if (existing) {
            commissionSupplierId = existing.id;
          } else {
            const [created] = await tx
              .insert(factorySuppliers)
              .values({ companyId, name: commName, isActive: true, parentId: existingSupplier.id })
              .returning();
            commissionSupplierId = created.id;
          }
        }

        // Opening balance is an actual receipt of stock, so it establishes/updates the
        // supplier's locked raw-material rate via the same moving-average formula as a
        // real container offload — must run BEFORE the raw-stock insert so "remaining
        // kg" reflects stock immediately before this receipt.
        await applyOffloadMovingAverage(tx, {
          companyId,
          supplierId: existingSupplier.id,
          newReceivedKg: kgVal,
          newContainerLandedCostPerKgUsd: costPerKgUsd,
        });

        const [rawStock] = await tx
          .insert(factoryRawStock)
          .values({
            companyId,
            containerId: container.id,
            receivedKg: String(kgVal),
            costPerKg: String(rateVal),
            costPerKgUsd: String(costPerKgUsd),
            ...(hasCommission
              ? {
                  commissionAmount: String(commAmountNum),
                  commissionCurrencyCode: commCurrency,
                  commissionFxRateToUsd: String(commFxRate),
                  commissionAmountUsd: String(commAmountUsd),
                  commissionSupplierId,
                }
              : {}),
          })
          .returning();

        const today = req.body.txDate || getClientDate(req);
        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: "OPENING_BALANCE_RAW",
          referenceId: rawStock.id,
          referenceTable: "factory_raw_stock",
          description: `Opening balance: ${containerNumber} - ${kgVal} kg at ${rateVal}/kg (${currencyCode})`,
          currencyCode,
          amountCurrency: totalPayable,
          fxRateToUsd: fxRate,
        });

        return { container, rawStock };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error creating opening balance:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // GET a single opening-balance raw stock record
  app.get("/api/factory/raw-stock/opening-balance/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const [row] = await db
        .select({
          id: factoryRawStock.id,
          containerId: factoryRawStock.containerId,
          receivedKg: factoryRawStock.receivedKg,
          usedKg: factoryRawStock.usedKg,
          costPerKg: factoryRawStock.costPerKg,
          costPerKgUsd: factoryRawStock.costPerKgUsd,
          containerNumber: factoryContainers.containerNumber,
          containerStatus: factoryContainers.status,
          currencyCode: factoryContainers.currencyCode,
          fxRateToUsd: factoryContainers.fxRateToUsd,
          notes: factoryContainers.notes,
          origin: factoryContainers.origin,
          supplierId: factoryContainers.supplierId,
          supplierName: factorySuppliers.name,
        })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
        .where(and(eq(factoryRawStock.id, id), eq(factoryRawStock.companyId, companyId)))
        .limit(1);

      if (!row) return res.status(404).json({ message: "Raw stock record not found" });
      if (row.containerStatus !== "OPENING_BALANCE") {
        return res.status(400).json({ message: "This record is not an opening balance entry" });
      }

      const received = parseFloat(row.receivedKg as string) || 0;
      const used = parseFloat(row.usedKg as string) || 0;

      res.json({ ...row, remainingKg: (received - used).toFixed(3) });
    } catch (error: unknown) {
      logger.error("Error fetching opening balance record:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH a single opening-balance raw stock record
  // (This route's catch block already returns 400 for any thrown error, including
  // UnresolvedExchangeRateError from the FX helpers used below.)
  app.patch("/api/factory/raw-stock/opening-balance/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const {
        supplierId: reqSupplierId,
        supplierName,
        receivedKg,
        costPerKg,
        currencyCode,
        fxRateToUsd,
        notes,
        commissionAmount,
        commissionCurrencyCode,
        commissionPersonName,
        commissionNotes,
        commissionFxRateToUsd,
      } = req.body;

      if (receivedKg !== undefined && parseFloat(receivedKg) <= 0) {
        return res.status(400).json({ message: "Received KG must be positive" });
      }
      if (costPerKg !== undefined && parseFloat(costPerKg) < 0) {
        return res.status(400).json({ message: "Cost per KG must be non-negative" });
      }
      if (fxRateToUsd !== undefined && parseFloat(fxRateToUsd) <= 0) {
        return res.status(400).json({ message: "FX rate must be positive" });
      }

      const [rawStockRow] = await db
        .select({ id: factoryRawStock.id, containerId: factoryRawStock.containerId })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .where(
          and(
            eq(factoryRawStock.id, id),
            eq(factoryRawStock.companyId, companyId),
            eq(factoryContainers.status, "OPENING_BALANCE")
          )
        )
        .limit(1);

      if (!rawStockRow) return res.status(404).json({ message: "Opening balance record not found" });

      await db.transaction(async (tx) => {
        const rawUpdates: Record<string, unknown> = {};
        const containerUpdates: Record<string, unknown> = {};

        if (receivedKg !== undefined) {
          rawUpdates.receivedKg = String(parseFloat(receivedKg));
          containerUpdates.totalKg = String(parseFloat(receivedKg));
          containerUpdates.declaredKg = String(parseFloat(receivedKg));
          containerUpdates.actualReceivedKg = String(parseFloat(receivedKg));
        }

        const effectiveCurrency = currencyCode || undefined;
        const effectiveFx = fxRateToUsd !== undefined ? parseFloat(fxRateToUsd) : undefined;
        const effectiveCost = costPerKg !== undefined ? parseFloat(costPerKg) : undefined;

        if (effectiveCost !== undefined) {
          rawUpdates.costPerKg = String(effectiveCost);
          containerUpdates.ratePerKg = String(effectiveCost);
        }
        if (effectiveCurrency !== undefined) containerUpdates.currencyCode = effectiveCurrency;
        if (effectiveFx !== undefined) containerUpdates.fxRateToUsd = String(effectiveFx);

        if (effectiveCost !== undefined || effectiveFx !== undefined || effectiveCurrency !== undefined) {
          const [current] = await tx
            .select({
              costPerKg: factoryRawStock.costPerKg,
              currencyCode: factoryContainers.currencyCode,
              fxRateToUsd: factoryContainers.fxRateToUsd,
              fxRateConfirmed: factoryContainers.fxRateConfirmed,
            })
            .from(factoryRawStock)
            .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
            .where(eq(factoryRawStock.id, id))
            .limit(1);

          const resolvedCost = effectiveCost ?? parseFloat(current?.costPerKg || "0");
          const resolvedCurrency = effectiveCurrency ?? current?.currencyCode ?? "USD";
          // effectiveFx is the caller's explicit new rate (already validated positive above);
          // otherwise fall back to the stored rate — but only if it's actually resolved, never
          // guessed as 1, since this edit may also be changing the currency to non-USD.
          let resolvedFx: number;
          if (effectiveFx !== undefined) {
            resolvedFx = effectiveFx;
          } else if (resolvedCurrency === "USD") {
            resolvedFx = 1;
          } else {
            resolvedFx = resolveStoredFxRateOrThrow(resolvedCurrency, current?.fxRateToUsd, current?.fxRateConfirmed);
          }
          const costUsd = resolvedCurrency === "USD" ? resolvedCost : resolvedCost * resolvedFx;
          rawUpdates.costPerKgUsd = String(costUsd);
          containerUpdates.ratePerKgUsd = String(costUsd);
        }

        if (notes !== undefined) containerUpdates.notes = notes;

        // Phase 4: commission field edits on OB raw-stock
        if (commissionAmount !== undefined) rawUpdates.commissionAmount = String(parseFloat(commissionAmount));
        if (commissionCurrencyCode !== undefined) rawUpdates.commissionCurrencyCode = commissionCurrencyCode;
        if (commissionPersonName !== undefined) rawUpdates.commissionPersonName = commissionPersonName;
        if (commissionNotes !== undefined) rawUpdates.commissionNotes = commissionNotes;
        if (commissionFxRateToUsd !== undefined)
          rawUpdates.commissionFxRateToUsd = String(parseFloat(commissionFxRateToUsd));
        if (
          commissionAmount !== undefined ||
          commissionFxRateToUsd !== undefined ||
          commissionCurrencyCode !== undefined
        ) {
          const [cur] = await tx
            .select({
              commissionCurrencyCode: factoryRawStock.commissionCurrencyCode,
              commissionFxRateToUsd: factoryRawStock.commissionFxRateToUsd,
            })
            .from(factoryRawStock)
            .where(eq(factoryRawStock.id, id))
            .limit(1);
          const resolvedCommCurr = commissionCurrencyCode ?? cur?.commissionCurrencyCode ?? "USD";
          const resolvedCommFx =
            resolvedCommCurr === "USD"
              ? 1
              : resolveStoredFxRateOrThrow(resolvedCommCurr, commissionFxRateToUsd ?? cur?.commissionFxRateToUsd);
          const resolvedCommAmt = parseFloat(commissionAmount ?? "0");
          rawUpdates.commissionAmountUsd =
            resolvedCommCurr === "USD" ? String(resolvedCommAmt) : String(resolvedCommAmt * resolvedCommFx);
        }

        if (reqSupplierId !== undefined) {
          const [sup] = await tx
            .select({ id: factorySuppliers.id })
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, parseInt(reqSupplierId)), eq(factorySuppliers.companyId, companyId)))
            .limit(1);
          if (!sup) throw new Error("Supplier not found");
          containerUpdates.supplierId = sup.id;
        } else if (supplierName !== undefined) {
          const trimmed = String(supplierName).trim();
          const [found] = await tx
            .select({ id: factorySuppliers.id })
            .from(factorySuppliers)
            .where(
              and(eq(factorySuppliers.companyId, companyId), sql`lower(${factorySuppliers.name}) = lower(${trimmed})`)
            )
            .limit(1);
          if (found) {
            containerUpdates.supplierId = found.id;
          } else {
            const [created] = await tx
              .insert(factorySuppliers)
              .values({ companyId, name: trimmed, isActive: true })
              .returning();
            containerUpdates.supplierId = created.id;
          }
        }

        if (Object.keys(rawUpdates).length > 0) {
          await tx.update(factoryRawStock).set(rawUpdates).where(eq(factoryRawStock.id, id));
        }
        if (Object.keys(containerUpdates).length > 0) {
          await tx
            .update(factoryContainers)
            .set(containerUpdates)
            .where(eq(factoryContainers.id, rawStockRow.containerId));
        }
      });

      res.json({ message: "Opening balance updated successfully" });
    } catch (error: unknown) {
      logger.error("Error updating opening balance:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE a single opening-balance raw stock record (bale-safe)
  app.delete("/api/factory/raw-stock/opening-balance/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const [rawStockRow] = await db
        .select({
          id: factoryRawStock.id,
          containerId: factoryRawStock.containerId,
          containerStatus: factoryContainers.status,
        })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .where(and(eq(factoryRawStock.id, id), eq(factoryRawStock.companyId, companyId)))
        .limit(1);

      if (!rawStockRow) return res.status(404).json({ message: "Raw stock record not found" });
      if (rawStockRow.containerStatus !== "OPENING_BALANCE") {
        return res
          .status(400)
          .json({ message: "This record is not an opening balance entry and cannot be deleted through this endpoint" });
      }

      await db.transaction(async (tx) => {
        // Safely detach: null out containerId on mix batch sources referencing this container
        await tx
          .update(factoryMixBatchSources)
          .set({ containerId: null })
          .where(eq(factoryMixBatchSources.containerId, rawStockRow.containerId));

        // Delete the raw stock row
        await tx.delete(factoryRawStock).where(eq(factoryRawStock.id, id));

        // Soft-delete the container by changing its status
        await tx
          .update(factoryContainers)
          .set({ status: "DELETED" })
          .where(eq(factoryContainers.id, rawStockRow.containerId));
      });

      res.json({ message: "Opening balance deleted. Linked bales remain intact." });
    } catch (error: unknown) {
      logger.error("Error deleting opening balance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
