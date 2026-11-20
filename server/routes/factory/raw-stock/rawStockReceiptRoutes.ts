import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { withFactoryValuationEventTx } from "../../../services/factory/factoryStockValueEvents";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { validateRequest } from "../../../lib/validateRequest";
import { deductReceivedInput, updateCostInput } from "./rawStockWriteRouteSchemas";
import { FACTORY_RAW_COST_UPDATE_RETIRED_MESSAGE } from "../../../services/factory/baleRecost";
import { writeDaybookEntry } from "../_helpers";
import { companyBusinessDate } from "../../../services/accounting/companyBusinessDate";
import { FactoryFxRateRequiredError, factoryDocumentRate } from "../../../services/factory/factoryDocumentFxRate";
import { factorySuppliers, factoryContainers, factoryRawStock, factoryRawMaterialAdjustments } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../lib/money";
import { ZERO } from "./rawStockReceiptRoutesTypes";
import { registerRawStockReceiptRoutesPart1 } from "./registerRawStockReceiptRoutesPart1";

export function registerRawStockReceiptRoutes(app: Express) {
  registerRawStockReceiptRoutesPart1(app);
  registerRawStockReceiptRoutesPart2(app);
}

function registerRawStockReceiptRoutesPart2(app: Express) {
  // Retired (accounting audit phase 19 C, F2). It set one native cost as USD on
  // every raw-stock row of the supplier (consumed rows too), rewrote ADD
  // adjustments, open mixes and their bales at 2dp, with no audit, no value
  // event and no cut-over check. Bale and mix costs change only through the
  // reviewed re-cost (GET /api/factory/bale-cost/recost-preview, Owner
  // POST /api/factory/bale-cost/recost-apply).
  app.post(
    "/api/factory/raw-stock/update-cost",
    requireAuth,
    validateRequest(updateCostInput),
    async (_req: Request, res: Response) => {
      res
        .status(410)
        .json({ code: "FACTORY_RAW_COST_UPDATE_RETIRED", message: FACTORY_RAW_COST_UPDATE_RETIRED_MESSAGE });
    }
  );

  // POST deduct from received_kg directly on factory_raw_stock rows for a supplier
  app.post(
    "/api/factory/raw-stock/deduct-received",
    requireAuth,
    validateRequest(deductReceivedInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { supplierId, kg, notes, reference, costPerKg, currencyCode, txDate } = req.body;
        if (!supplierId) return res.status(400).json({ message: "supplierId is required" });
        const deductKgInput = kg ? parseMoneyInput(kg) : null;
        if (deductKgInput === null || deductKgInput.lte(0)) return res.status(400).json({ message: "kg must be > 0" });

        const deductKgExact = deductKgInput;
        // A cost that does not parse leaves no daybook entry, as NaN > 0 did.
        const costPerKgExact = (costPerKg ? parseMoneyInput(costPerKg) : null) ?? ZERO;
        // Plain numbers for stored text and descriptions, as before.
        const deductKg = deductKgExact.toNumber();
        const costPerKgNum = costPerKgExact.toNumber();
        const ccy = currencyCode || "USD";
        // Phase 19 C (M3): the deduction is dated by the date entered, else the
        // company's business date (was the client's date).
        if (txDate != null && txDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(txDate)))
          return res.status(400).json({ message: "txDate must be a YYYY-MM-DD date" });
        const today = txDate ? String(txDate) : await companyBusinessDate(companyId);

        // Find all raw_stock rows for this supplier, ordered newest first
        const rows = await db
          .select({
            id: factoryRawStock.id,
            receivedKg: factoryRawStock.receivedKg,
            usedKg: factoryRawStock.usedKg,
          })
          .from(factoryRawStock)
          .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
          .where(
            and(
              eq(factoryRawStock.companyId, companyId),
              eq(factoryContainers.supplierId, Number(supplierId)),
              sql`${factoryContainers.status} != 'DELETED'`
            )
          )
          .orderBy(desc(factoryRawStock.offloadedAt));

        // Allow over-use: no guard here — deduction can drive remaining stock negative

        // Deduct from rows newest-first; allow received to go below used (negative stock)
        let remaining: Decimal = deductKgExact;
        const updates: { id: number; newReceived: Decimal }[] = [];
        for (const row of rows) {
          if (remaining.lte(0)) break;
          const received = toMoney(row.receivedKg);
          // Allow over-use: deduct from received up to its full amount (may leave usedKg > receivedKg)
          const take = MoneyDecimal.min(remaining, received);
          if (take.gt(0)) {
            updates.push({ id: row.id, newReceived: received.minus(take) });
            remaining = remaining.minus(take);
          }
        }

        // Any remaining kg after row deductions → create a REMOVE adjustment
        const adjDeductKg = remaining.gt("0.001") ? remaining : ZERO;

        // Phase 19 C (M3): a non-USD daybook value takes the recorded factory rate
        // on or before the deduction date, or the deduction is refused (409). It
        // used to take a fetched rate, or 1 when the fetch failed.
        let fxRate = 1;
        if (ccy !== "USD" && costPerKgExact.gt(0)) {
          try {
            fxRate = toMoney((await factoryDocumentRate(db, companyId, ccy, today)).rate).toNumber();
          } catch (rateError) {
            if (rateError instanceof FactoryFxRateRequiredError) return res.status(409).json(rateError.body);
            throw rateError;
          }
        }

        // Wave 11: the kg taken off received stock leave the factory raw-material
        // valuation; the daily factory stock journal posts that change as a
        // write-off (WASTE), not as production variance.
        await db.transaction((tx) =>
          withFactoryValuationEventTx(
            tx,
            companyId,
            "WASTE",
            { sourceType: "factory-raw-deduct-received", sourceId: Number(supplierId) },
            async () => {
              // 1. Update actual rows
              for (const u of updates) {
                await tx
                  .update(factoryRawStock)
                  .set({ receivedKg: u.newReceived.toFixed(3) })
                  .where(eq(factoryRawStock.id, u.id));
              }

              // 1b. Record a DEDUCT history entry for the amount taken from container rows
              // DEDUCT type is skipped in all balance calculations — it only exists for history visibility.
              const rowDeductKg = deductKgExact.minus(adjDeductKg);
              if (rowDeductKg.gt("0.001")) {
                await tx.insert(factoryRawMaterialAdjustments).values({
                  companyId,
                  date: today,
                  type: "DEDUCT",
                  kg: rowDeductKg.toFixed(3),
                  costPerKg: costPerKgNum > 0 ? String(costPerKgNum) : "0",
                  currencyCode: ccy,
                  supplierId: Number(supplierId),
                  notes: notes || null,
                  reference: reference || null,
                });
              }

              // 2. REMOVE adjustment for any overflow (from adjustment-sourced free)
              if (adjDeductKg.gt(0)) {
                await tx
                  .insert(factoryRawMaterialAdjustments)
                  .values({
                    companyId,
                    date: today,
                    type: "REMOVE",
                    kg: adjDeductKg.toFixed(3),
                    costPerKg: costPerKgNum > 0 ? String(costPerKgNum) : "0",
                    currencyCode: ccy,
                    supplierId: Number(supplierId),
                    notes: notes ? `${notes} (auto-adj)` : "Deduct from received (auto-adj)",
                    reference: reference || null,
                  })
                  .returning();
              }

              // 3. Write daybook entry for the balance update (if costPerKg provided)
              if (costPerKgExact.gt(0)) {
                const totalValue = deductKgExact.times(costPerKgExact);
                const totalValueUsd = totalValue.times(fxRate);

                const [sup] = await tx
                  .select({ name: factorySuppliers.name })
                  .from(factorySuppliers)
                  .where(and(eq(factorySuppliers.id, Number(supplierId)), eq(factorySuppliers.companyId, companyId)))
                  .limit(1);
                const supplierName = sup?.name || `Supplier #${supplierId}`;

                await writeDaybookEntry(tx, {
                  companyId,
                  txDate: today,
                  txType: "RAW_DEDUCT_RECEIVED",
                  referenceId: Number(supplierId),
                  description: `Deduct from received: ${deductKg} kg @ ${costPerKgNum} ${ccy} — ${supplierName}${notes ? ` (${notes})` : ""}`,
                  currencyCode: ccy,
                  amountCurrency: totalValue.negated().toNumber(),
                  fxRateToUsd: fxRate,
                  amountUsd: totalValueUsd.negated().toNumber(),
                });
              }
            }
          )
        );

        res.json({ deducted: deductKg, rowsUpdated: updates.length, adjCreated: adjDeductKg.gt(0) });
      } catch (error: unknown) {
        logger.error("Error deducting received kg:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
