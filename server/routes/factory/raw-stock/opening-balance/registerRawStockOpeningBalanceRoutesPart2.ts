// Extracted from ./registerRawStockOpeningBalanceRoutesPart1.ts
import type { Express, Request, Response } from "express";
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
import { syncContainerCommissionJournalTx } from "../../../../services/factory/containerCommissionJournal";
import { factoryContainers, factoryRawStock, factorySuppliers } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { parseMoneyInput, toMoney } from "../../../../lib/money";

export function registerRawStockOpeningBalanceRoutesPart2(app: Express) {
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
      // A non-numeric value used to pass these checks (NaN <= 0 is false) and was stored as NaN.
      const kgInput = receivedKg ? parseMoneyInput(receivedKg) : null;
      if (kgInput === null || kgInput.lte(0)) return res.status(400).json({ message: "Received KG must be positive" });
      const rateInput = costPerKg ? parseMoneyInput(costPerKg) : null;
      if (rateInput === null || rateInput.lt(0))
        return res.status(400).json({ message: "Cost per KG must be non-negative" });

      const currencyCode = reqCurrency || "USD";
      const kgVal = kgInput.toNumber();
      const rateVal = rateInput.toNumber();
      let costPerKgUsd: number;
      try {
        costPerKgUsd = convertToUsdOrThrow(rateVal, currencyCode, reqFxRate);
      } catch (err: unknown) {
        if (err instanceof UnresolvedExchangeRateError) return res.status(400).json({ message: err.message });
        throw err;
      }
      const fxRate = currencyCode === "USD" ? 1 : (parseMoneyInput(reqFxRate)?.toNumber() ?? Number.NaN);
      const totalPayable = kgInput.times(rateInput);
      const totalPayableUsd = kgInput.times(costPerKgUsd);
      const trimmedSupplierName = String(supplierName).trim();

      // Commission is a separate new record on this same write — its non-USD rate must be
      // explicitly supplied too, never silently defaulted to 1 like the main container rate.
      const commAmountInput = reqCommAmount ? parseMoneyInput(reqCommAmount) : null;
      const hasCommissionReq = commAmountInput !== null && commAmountInput.gt(0);
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
        let existingSupplier:
          | {
              id: number;
              companyId: number;
              name: string;
              contactPerson: string | null;
              phone: string | null;
              email: string | null;
              address: string | null;
              notes: string | null;
              openingBalance: string;
              linkedSupplierId: number | null;
              parentId: number | null;
              supplierCategoryId: number | null;
              isActive: boolean;
              isBroker: boolean;
              currentRawMaterialCostPerKgUsd: string | null;
              createdAt: Date;
              updatedAt: Date;
            }
          | {
              name: string;
              id: number;
              email: string | null;
              companyId: number;
              notes: string | null;
              createdAt: Date;
              updatedAt: Date;
              phone: string | null;
              openingBalance: string;
              isActive: boolean;
              parentId: number | null;
              address: string | null;
              contactPerson: string | null;
              linkedSupplierId: number | null;
              supplierCategoryId: number | null;
              isBroker: boolean;
              currentRawMaterialCostPerKgUsd: string | null;
            };
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
            finalPayableAmount: totalPayable.toString(),
            differenceKg: "0",
            currencyCode,
            fxRateToUsd: String(fxRate),
            ratePerKgUsd: String(costPerKgUsd),
            finalPayableAmountUsd: totalPayableUsd.toString(),
            notes: notes || "Opening balance import",
            status: "OPENING_BALANCE",
          })
          .returning();

        // Commission processing — auto-create/reuse "[SupplierName] Commission" sub-account
        const hasCommission = hasCommissionReq;
        const commCurrency = commCurrencyCode;
        const commFxRate = commFxRateResolved;
        const commAmount = hasCommission ? commAmountInput : toMoney(0);
        const commAmountUsd = commCurrency === "USD" ? commAmount : commAmount.times(commFxRate);

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
                  commissionAmount: String(commAmount.toNumber()),
                  commissionCurrencyCode: commCurrency,
                  commissionFxRateToUsd: String(commFxRate),
                  commissionAmountUsd: commAmountUsd.toString(),
                  commissionSupplierId,
                }
              : {}),
          })
          .returning();
        // Wave 14: the commission held on the opening-balance row posts
        // FACTORY-COMM-{container} in this transaction (or stays listed).
        if (hasCommission) await syncContainerCommissionJournalTx(tx, companyId, container.id);

        const today = req.body.txDate || getClientDate(req);
        await writeDaybookEntry(tx, {
          companyId,
          txDate: today,
          txType: "OPENING_BALANCE_RAW",
          referenceId: rawStock.id,
          referenceTable: "factory_raw_stock",
          description: `Opening balance: ${containerNumber} - ${kgVal} kg at ${rateVal}/kg (${currencyCode})`,
          currencyCode,
          amountCurrency: totalPayable.toNumber(),
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
}
