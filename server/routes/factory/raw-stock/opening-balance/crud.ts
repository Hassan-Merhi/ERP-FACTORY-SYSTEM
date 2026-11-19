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
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { resolveStoredFxRateOrThrow } from "../../../../services/factory/currencyConversion";
import { syncContainerCommissionJournalTx } from "../../../../services/factory/containerCommissionJournal";
import { factorySuppliers, factoryContainers, factoryRawStock, factoryMixBatchSources } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { parseMoneyInput, toMoney } from "../../../../lib/money";
import { registerRawStockOpeningBalanceRoutesPart1 } from "./registerRawStockOpeningBalanceRoutesPart1";

export function registerRawStockOpeningBalanceRoutes(app: Express) {
  registerRawStockOpeningBalanceRoutesPart1(app);
  registerRawStockOpeningBalanceRoutesPart2(app);
}

function registerRawStockOpeningBalanceRoutesPart2(app: Express) {
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

      // A non-numeric value used to pass these checks (NaN <= 0 is false) and was stored as NaN.
      const kgInput = receivedKg !== undefined ? parseMoneyInput(receivedKg) : undefined;
      if (kgInput !== undefined && (kgInput === null || kgInput.lte(0))) {
        return res.status(400).json({ message: "Received KG must be positive" });
      }
      const costInput = costPerKg !== undefined ? parseMoneyInput(costPerKg) : undefined;
      if (costInput !== undefined && (costInput === null || costInput.lt(0))) {
        return res.status(400).json({ message: "Cost per KG must be non-negative" });
      }
      const fxInput = fxRateToUsd !== undefined ? parseMoneyInput(fxRateToUsd) : undefined;
      if (fxInput !== undefined && (fxInput === null || fxInput.lte(0))) {
        return res.status(400).json({ message: "FX rate must be positive" });
      }
      const commissionInput = commissionAmount !== undefined ? parseMoneyInput(commissionAmount) : undefined;
      if (commissionInput === null) {
        return res.status(400).json({ message: "Commission amount must be a number" });
      }
      const commissionFxInput =
        commissionFxRateToUsd !== undefined ? parseMoneyInput(commissionFxRateToUsd) : undefined;
      if (commissionFxInput === null) {
        return res.status(400).json({ message: "Commission FX rate must be a number" });
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

        if (kgInput) {
          const kgText = String(kgInput.toNumber());
          rawUpdates.receivedKg = kgText;
          containerUpdates.totalKg = kgText;
          containerUpdates.declaredKg = kgText;
          containerUpdates.actualReceivedKg = kgText;
        }

        const effectiveCurrency = currencyCode || undefined;
        const effectiveFx = fxInput ? fxInput.toNumber() : undefined;
        const effectiveCost = costInput ? costInput.toNumber() : undefined;

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

          const resolvedCost = effectiveCost ?? toMoney(current?.costPerKg).toNumber();
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
          const costUsd = resolvedCurrency === "USD" ? toMoney(resolvedCost) : toMoney(resolvedCost).times(resolvedFx);
          rawUpdates.costPerKgUsd = costUsd.toString();
          containerUpdates.ratePerKgUsd = costUsd.toString();
        }

        if (notes !== undefined) containerUpdates.notes = notes;

        // Phase 4: commission field edits on OB raw-stock
        if (commissionInput) rawUpdates.commissionAmount = String(commissionInput.toNumber());
        if (commissionCurrencyCode !== undefined) rawUpdates.commissionCurrencyCode = commissionCurrencyCode;
        if (commissionPersonName !== undefined) rawUpdates.commissionPersonName = commissionPersonName;
        if (commissionNotes !== undefined) rawUpdates.commissionNotes = commissionNotes;
        if (commissionFxInput) rawUpdates.commissionFxRateToUsd = String(commissionFxInput.toNumber());
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
          const resolvedCommAmt = commissionInput ?? toMoney(0);
          rawUpdates.commissionAmountUsd =
            resolvedCommCurr === "USD"
              ? String(resolvedCommAmt.toNumber())
              : resolvedCommAmt.times(resolvedCommFx).toString();
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
        // Wave 14: the commission journal follows the edited row (amount,
        // currency, rate, or the container's supplier/currency/rate it reads).
        const commissionInputsChanged =
          commissionAmount !== undefined ||
          commissionCurrencyCode !== undefined ||
          commissionFxRateToUsd !== undefined ||
          "supplierId" in containerUpdates ||
          "currencyCode" in containerUpdates ||
          "fxRateToUsd" in containerUpdates;
        if (commissionInputsChanged) {
          await syncContainerCommissionJournalTx(tx, companyId, rawStockRow.containerId);
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
        // Wave 14: its commission journal goes with the row.
        await syncContainerCommissionJournalTx(tx, companyId, rawStockRow.containerId);
      });

      res.json({ message: "Opening balance deleted. Linked bales remain intact." });
    } catch (error: unknown) {
      logger.error("Error deleting opening balance:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
