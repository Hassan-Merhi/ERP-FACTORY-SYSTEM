import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { withFactoryValuationEventTx } from "../../../services/factory/factoryStockValueEvents";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getLockedSupplierRate } from "../../../services/factory/rawStockLockedRate";
import { writeDaybookEntry, getOrCreateLedgerAccount } from "../_helpers";
import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  voucherEntries,
  factoryDaybookEntries,
  factoryRawMaterialAdjustments,
  vouchers,
} from "@shared/schema";
import { eq, and, desc, sql, inArray, ilike, isNull } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { normFactoryEntry } from "../../../services/factory/factoryVoucherEntryAmounts";
import { FactoryFxRateRequiredError, factoryDocumentRate } from "../../../services/factory/factoryDocumentFxRate";
import { syncContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

const ZERO = new MoneyDecimal(0);

export function registerRawStockAdjRoutes(app: Express) {
  app.get("/api/factory/raw-stock/adjustments", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select({
          id: factoryRawMaterialAdjustments.id,
          companyId: factoryRawMaterialAdjustments.companyId,
          date: factoryRawMaterialAdjustments.date,
          type: factoryRawMaterialAdjustments.type,
          kg: factoryRawMaterialAdjustments.kg,
          costPerKg: factoryRawMaterialAdjustments.costPerKg,
          currencyCode: factoryRawMaterialAdjustments.currencyCode,
          supplierId: factoryRawMaterialAdjustments.supplierId,
          supplierName: factorySuppliers.name,
          materialLabel: factoryRawMaterialAdjustments.materialLabel,
          notes: factoryRawMaterialAdjustments.notes,
          createdAt: factoryRawMaterialAdjustments.createdAt,
        })
        .from(factoryRawMaterialAdjustments)
        .leftJoin(
          factorySuppliers,
          and(
            eq(factoryRawMaterialAdjustments.supplierId, factorySuppliers.id),
            eq(factorySuppliers.companyId, companyId)
          )
        )
        .where(
          and(eq(factoryRawMaterialAdjustments.companyId, companyId), isNull(factoryRawMaterialAdjustments.deletedAt))
        )
        .orderBy(desc(factoryRawMaterialAdjustments.createdAt));
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET combined history for a specific supplier's raw material
  // Returns adjustments + mix batch usage sorted newest-first
  app.get("/api/factory/raw-stock/history/:supplierId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const supplierId = parseId(req.params.supplierId);
      if (supplierId === null) return res.status(400).json({ message: "Invalid id" });
      if (!supplierId) return res.status(400).json({ message: "supplierId required" });

      // 1. Manual adjustments for this supplier
      const adjRows = await db
        .select({
          id: factoryRawMaterialAdjustments.id,
          date: factoryRawMaterialAdjustments.date,
          type: factoryRawMaterialAdjustments.type,
          kg: factoryRawMaterialAdjustments.kg,
          costPerKg: factoryRawMaterialAdjustments.costPerKg,
          currencyCode: factoryRawMaterialAdjustments.currencyCode,
          notes: factoryRawMaterialAdjustments.notes,
          reference: factoryRawMaterialAdjustments.reference,
          materialLabel: factoryRawMaterialAdjustments.materialLabel,
          createdAt: factoryRawMaterialAdjustments.createdAt,
        })
        .from(factoryRawMaterialAdjustments)
        .where(
          and(
            eq(factoryRawMaterialAdjustments.companyId, companyId),
            eq(factoryRawMaterialAdjustments.supplierId, supplierId),
            isNull(factoryRawMaterialAdjustments.deletedAt)
          )
        )
        .orderBy(desc(factoryRawMaterialAdjustments.createdAt));

      // 2. Mix batch usage: batch sources referencing this supplier (aggregate per batch)
      //
      // IMPORTANT: costPerKg must come from factoryMixBatchSources (this supplier's own
      // rate for the material it contributed), NOT from factoryMixBatches.costPerKg.
      // The batch's costPerKg is a weighted BLEND across every supplier/source that fed
      // that batch — showing it here would silently attribute other suppliers' material
      // cost (or dilute this supplier's true cost) whenever a batch draws from more than
      // one source. Aggregating this supplier's own source rows (weight-averaged if a
      // batch drew from this supplier more than once) is the only correct per-supplier figure.
      const batchSourceRows = await db
        .select({
          batchId: factoryMixBatches.id,
          batchCode: factoryMixBatches.batchCode,
          batchName: factoryMixBatches.name,
          batchStatus: factoryMixBatches.status,
          batchDate: factoryMixBatches.batchDate,
          createdAt: factoryMixBatches.createdAt,
          weightKg: factoryMixBatchSources.weightKg,
          costPerKg: factoryMixBatchSources.costPerKg,
          totalCost: factoryMixBatchSources.totalCost,
        })
        .from(factoryMixBatchSources)
        .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
        .where(
          and(
            eq(factoryMixBatches.companyId, companyId),
            eq(factoryMixBatchSources.supplierId, supplierId),
            isNull(factoryMixBatches.deletedAt)
          )
        )
        .orderBy(desc(factoryMixBatches.createdAt));

      // Aggregate multiple source rows for the same batch into one timeline entry.
      // costPerKg is derived as totalCost / kg across THIS supplier's source rows only,
      // so a batch fed by this supplier more than once still shows one correct weighted rate.
      const batchAggMap = new Map();
      for (const r of batchSourceRows) {
        const kg = toMoney(r.weightKg);
        const storedCost = toMoney(r.totalCost);
        const cost = storedCost.isZero() ? kg.times(toMoney(r.costPerKg)) : storedCost;
        if (batchAggMap.has(r.batchId)) {
          const agg = batchAggMap.get(r.batchId);
          agg.kg = agg.kg.plus(kg);
          agg._cost = agg._cost.plus(cost);
        } else {
          batchAggMap.set(r.batchId, {
            kind: "batch" as const,
            date: r.batchDate || r.createdAt,
            createdAt: r.createdAt,
            type: "USED",
            kg,
            _cost: cost,
            currencyCode: "USD",
            notes: null,
            label: `Mix Batch — ${r.batchName || r.batchCode}`,
            ref: r.batchCode,
            batchStatus: r.batchStatus,
            batchId: r.batchId,
          });
        }
      }
      const batches = Array.from(batchAggMap.values()).map((r) => {
        const { _cost, kg, ...rest } = r;
        return { ...rest, kg: kg.toNumber(), costPerKg: kg.gt(0) ? _cost.div(kg).toNumber() : 0 };
      });

      // 3. Container-based raw stock receipts for this supplier
      const containerRows = await db
        .select({
          id: factoryRawStock.id,
          receivedKg: factoryRawStock.receivedKg,
          usedKg: factoryRawStock.usedKg,
          // costPerKgUsd is computed at offload time as totalCost / actualReceivedKg,
          // so it correctly reflects the reduced received quantity. costPerKg is the
          // declared container rate (based on full expected weight) and would be too low
          // when fewer kg were received.
          costPerKgUsd: factoryRawStock.costPerKgUsd,
          costPerKg: factoryRawStock.costPerKg,
          offloadedAt: factoryRawStock.offloadedAt,
          containerNumber: factoryContainers.containerNumber,
          origin: factoryContainers.origin,
          currencyCode: factoryContainers.currencyCode,
        })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .where(
          and(
            eq(factoryRawStock.companyId, companyId),
            eq(factoryContainers.supplierId, supplierId),
            sql`${factoryContainers.status} != 'DELETED'`
          )
        )
        .orderBy(desc(factoryRawStock.offloadedAt));

      const receipts = containerRows.map((r) => ({
        kind: "receipt" as const,
        date: r.offloadedAt,
        createdAt: r.offloadedAt,
        type: "RECEIPT",
        kg: toMoney(r.receivedKg).toNumber(),
        usedKg: toMoney(r.usedKg).toNumber(),
        rawStockId: r.id,
        // Prefer the USD rate (computed from actual received kg at offload time);
        // fall back to the native rate only if costPerKgUsd is absent (legacy rows).
        costPerKg: (toMoney(r.costPerKgUsd).isZero() ? toMoney(r.costPerKg) : toMoney(r.costPerKgUsd)).toNumber(),
        currencyCode: "USD",
        notes: r.origin ? `Origin: ${r.origin}` : null,
        label: `Container Receipt — ${r.containerNumber || `#${r.id}`}`,
        ref: r.containerNumber || `CONTAINER-${r.id}`,
        batchStatus: null,
        batchId: null,
      }));

      // Also expose adjId on adjustments
      const adjustmentsWithId = adjRows.map((r) => ({
        kind: "adjustment" as const,
        adjId: r.id,
        date: r.date || r.createdAt,
        createdAt: r.createdAt,
        type: r.type,
        kg: toMoney(r.kg).toNumber(),
        costPerKg: toMoney(r.costPerKg).toNumber(),
        currencyCode: r.currencyCode || "USD",
        notes: r.notes,
        reference: r.reference || null,
        label: r.type === "ADD" ? "Manual Addition" : r.type === "DEDUCT" ? "Deduct from Received" : "Manual Deduction",
        ref: r.reference ? r.reference : `ADJ-${r.id}`,
      }));

      const all = [...adjustmentsWithId, ...batches, ...receipts].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      res.json(all);
    } catch (error: unknown) {
      logger.error("Raw material history error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST create a new adjustment (ADD or REMOVE), or create a new standalone manual material
  app.post("/api/factory/raw-stock/adjustment", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { type, kg, costPerKg, currencyCode, supplierId, materialLabel, notes, reference, date, createVoucher } =
        req.body;
      if (!type || !["ADD", "REMOVE"].includes(type))
        return res.status(400).json({ message: "type must be ADD or REMOVE" });
      // A non-numeric kg used to pass this check (NaN <= 0 is false) and was stored as NaN.
      const kgInput = kg ? parseMoneyInput(kg) : null;
      if (kgInput === null || kgInput.lte(0)) return res.status(400).json({ message: "kg must be > 0" });
      if (!date) return res.status(400).json({ message: "date is required" });

      const kgExact = kgInput;
      const ccy = currencyCode || "USD";
      const resolvedSupplierId = supplierId ? Number(supplierId) : null;

      // ADD is a quantity-only adjustment for a REAL supplier — it must NEVER
      // establish or shift the supplier's locked raw-material rate. Any client-
      // supplied costPerKg is ignored; the existing locked rate is used instead.
      // If no rate has ever been established for this supplier, reject and direct
      // to the real receipt paths (container offload / opening balance) that are
      // authorized to set it. A supplier-less (MANUAL) adjustment isn't tied to a
      // locked rate, so the client-supplied cost is still accepted there.
      // A cost that does not parse is treated as no cost, as NaN > 0 was.
      let costExact: Decimal = (costPerKg ? parseMoneyInput(costPerKg) : null) ?? ZERO;
      if (type === "ADD" && resolvedSupplierId) {
        const lockedRate = toMoney(await getLockedSupplierRate(db, companyId, resolvedSupplierId));
        if (lockedRate.lte(0)) {
          return res.status(400).json({
            message:
              "This supplier has no established raw-material rate yet. Use a container offload or the opening-balance workflow to record the first receipt.",
          });
        }
        costExact = lockedRate;
      }
      const totalAmount = kgExact.times(costExact);
      // Plain numbers for stored text and descriptions, as before.
      const kgNum = kgExact.toNumber();
      const costNum = costExact.toNumber();

      // Pre-fetch ledger account IDs before transaction (getOrCreateLedgerAccount must run outside tx)
      let rawMaterialAcctId: number | null = null;
      if (createVoucher && resolvedSupplierId && type === "ADD" && costExact.gt(0)) {
        rawMaterialAcctId = await getOrCreateLedgerAccount(
          companyId,
          "FACTORY_RAW_MATERIAL_STOCK",
          "Factory Raw Material Stock",
          "ASSET"
        );
      }

      // Wave 17 (D): the purchase voucher of a non-USD adjustment is posted at the
      // confirmed factory rate on or before its date, or refused (409). It used
      // to take a fetched rate, or 1 when the fetch failed, and then the legacy
      // shape (native amount in the USD columns).
      let fxRate = "1";
      if (rawMaterialAcctId && totalAmount.gt(0) && ccy !== "USD") {
        try {
          fxRate = (await factoryDocumentRate(db, companyId, ccy, String(date).slice(0, 10))).rate;
        } catch (rateError) {
          if (rateError instanceof FactoryFxRateRequiredError) return res.status(409).json(rateError.body);
          throw rateError;
        }
      }

      let inserted: typeof factoryRawMaterialAdjustments.$inferSelect | undefined;
      await db.transaction(async (tx) => {
        [inserted] = await tx
          .insert(factoryRawMaterialAdjustments)
          .values({
            companyId,
            date,
            type,
            kg: String(kgNum),
            costPerKg: costNum > 0 ? String(costNum) : "0",
            currencyCode: ccy,
            supplierId: resolvedSupplierId,
            materialLabel: materialLabel || null,
            notes: notes || null,
            reference: reference || null,
          })
          .returning();

        // Accounting voucher: Dr Raw Material Stock / Cr Supplier Account
        if (createVoucher && resolvedSupplierId && rawMaterialAcctId && totalAmount.gt(0)) {
          // Look up supplier name for description
          const [sup] = await tx
            .select({ name: factorySuppliers.name })
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, resolvedSupplierId), eq(factorySuppliers.companyId, companyId)))
            .limit(1);
          const supplierName = sup?.name || `Supplier #${resolvedSupplierId}`;

          const voucherNum = `FACTORY-MANUAL-${inserted.id}-${Date.now()}`;
          const [voucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: voucherNum,
              voucherDate: date,
              description: `Manual raw material purchase: ${kgNum} kg @ ${costNum}/${ccy} — ${supplierName}`,
              totalAmount: moneyString(totalAmount),
              currency: ccy,
              exchangeRate: fxRate,
              sourceModule: "FACTORY",
            })
            .returning();

          // Dr Raw Material Stock (both legs normalized at the purchase's rate, wave 6)
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: rawMaterialAcctId,
            ...normFactoryEntry(ccy, moneyString(totalAmount), "0", fxRate),
            narration: `Raw material stock — ${kgNum} kg from ${supplierName}`,
          });

          // Cr Supplier
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            factorySupplierId: resolvedSupplierId,
            ...normFactoryEntry(ccy, "0", moneyString(totalAmount), fxRate),
            narration: `Payable to ${supplierName} for raw material`,
          });

          await writeDaybookEntry(tx, {
            companyId,
            txDate: date,
            txType: "OFFLOAD_RAW_STOCK",
            referenceId: inserted.id,
            referenceTable: "factory_raw_stock",
            description: `Manual purchase: ${kgNum} kg @ ${costNum} ${ccy} from ${supplierName}`,
            currencyCode: ccy,
            amountCurrency: totalAmount.toNumber(),
            fxRateToUsd: toMoney(fxRate).toNumber(),
          });
        }
      });

      res.json(inserted);
    } catch (error: unknown) {
      logger.error("Error creating raw stock adjustment:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE a specific adjustment
  app.delete("/api/factory/raw-stock/adjustments/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      // Fetch the adjustment to know whether it has linked accounting
      const [adj] = await db
        .select()
        .from(factoryRawMaterialAdjustments)
        .where(
          and(
            eq(factoryRawMaterialAdjustments.id, id),
            eq(factoryRawMaterialAdjustments.companyId, companyId),
            isNull(factoryRawMaterialAdjustments.deletedAt)
          )
        )
        .limit(1);
      if (!adj) return res.status(404).json({ message: "Adjustment not found" });

      if (adj.type === "DEDUCT" && adj.supplierId) {
        // For DEDUCT: restore receivedKg on the supplier's raw stock rows (LIFO — newest first),
        // then hard-delete the record so it no longer appears in the list.
        const stockRows = await db
          .select({ id: factoryRawStock.id, receivedKg: factoryRawStock.receivedKg })
          .from(factoryRawStock)
          .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
          .where(
            and(
              eq(factoryRawStock.companyId, companyId),
              eq(factoryContainers.supplierId, adj.supplierId),
              sql`${factoryContainers.status} != 'DELETED'`
            )
          )
          .orderBy(desc(factoryRawStock.offloadedAt));

        // Wave 11: restoring a deduction reverses its write-off (WASTE) in the
        // daily factory stock journal.
        await db.transaction((tx) =>
          withFactoryValuationEventTx(
            tx,
            companyId,
            "WASTE",
            { sourceType: "factory-raw-deduct-restore", sourceId: id },
            async () => {
              let remaining = toMoney(adj.kg);
              for (const row of stockRows) {
                if (remaining.lte("0.001")) break;
                const received = toMoney(row.receivedKg);
                // Add back all remaining to this row (newest first)
                await tx
                  .update(factoryRawStock)
                  .set({ receivedKg: received.plus(remaining).toFixed(3) })
                  .where(eq(factoryRawStock.id, row.id));
                remaining = ZERO;
              }
              // Hard-delete the DEDUCT record
              await tx
                .delete(factoryRawMaterialAdjustments)
                .where(
                  and(eq(factoryRawMaterialAdjustments.id, id), eq(factoryRawMaterialAdjustments.companyId, companyId))
                );
            }
          )
        );
      } else {
        // For ADD / REMOVE: soft-delete + clean up linked daybook entries and vouchers
        await db.transaction(async (tx) => {
          await tx
            .update(factoryRawMaterialAdjustments)
            .set({ deletedAt: new Date() })
            .where(
              and(eq(factoryRawMaterialAdjustments.id, id), eq(factoryRawMaterialAdjustments.companyId, companyId))
            );

          // Delete linked OFFLOAD_RAW_STOCK daybook entry (referenceId = adjustment id)
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "OFFLOAD_RAW_STOCK"),
                eq(factoryDaybookEntries.referenceId, id)
              )
            );

          // Delete linked voucher (pattern: FACTORY-MANUAL-{id}-*)
          const linkedVouchers = await tx
            .select({ id: vouchers.id })
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, companyId),
                eq(vouchers.sourceModule, "FACTORY"),
                ilike(vouchers.voucherNumber, `FACTORY-MANUAL-${id}-%`)
              )
            );
          if (linkedVouchers.length > 0) {
            const vIds = linkedVouchers.map((v) => v.id);
            // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
            await retireVouchersTx(tx, {
              companyId,
              voucherIds: vIds,
              reason: "factory-raw-stock-adjustment-delete",
              actor: sessionRetirementActor(req),
            });
          }
        });
      }

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting raw stock adjustment:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE a batch source entry for a supplier from a batch (reverses usedKg on raw stock)
  app.delete("/api/factory/raw-stock/batch-source", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const batchId = parseId(req.body.batchId) ?? -1;
      const supplierId = parseId(req.body.supplierId) ?? -1;
      if (isNaN(batchId) || isNaN(supplierId))
        return res.status(400).json({ message: "batchId and supplierId are required" });

      await db.transaction(async (tx) => {
        // Verify batch belongs to this company
        const [batch] = await tx
          .select()
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, batchId), eq(factoryMixBatches.companyId, companyId)))
          .limit(1);
        if (!batch) throw new Error("Batch not found");

        // Find all source records for this supplier in this batch
        const sources = await tx
          .select()
          .from(factoryMixBatchSources)
          .where(
            and(eq(factoryMixBatchSources.mixBatchId, batchId), eq(factoryMixBatchSources.supplierId, supplierId))
          );
        if (sources.length === 0) throw new Error("No source records found for this supplier in this batch");

        let totalKgToReverse: Decimal = ZERO;
        let totalCostToReverse: Decimal = ZERO;

        for (const src of sources) {
          const srcKg = toMoney(src.weightKg);
          totalKgToReverse = totalKgToReverse.plus(srcKg);
          totalCostToReverse = totalCostToReverse.plus(toMoney(src.totalCost));

          // If this source references a container raw stock row, reverse usedKg
          if (src.containerId) {
            await tx
              .update(factoryRawStock)
              .set({ usedKg: sql`GREATEST(0, ${factoryRawStock.usedKg} - ${srcKg.toString()})` })
              .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, src.containerId)));
          }
        }

        // Delete all source records for this supplier in this batch
        await tx
          .delete(factoryMixBatchSources)
          .where(
            and(eq(factoryMixBatchSources.mixBatchId, batchId), eq(factoryMixBatchSources.supplierId, supplierId))
          );

        // Update the batch totals
        const newTotalKg = MoneyDecimal.max(0, toMoney(batch.totalWeightKg).minus(totalKgToReverse));
        const newTotalCost = MoneyDecimal.max(0, toMoney(batch.totalCost).minus(totalCostToReverse));
        // total_weight_kg holds 3 decimals, total_cost and cost_per_kg 7.
        const newCostPerKg = newTotalKg.gt(0) ? newTotalCost.div(newTotalKg) : ZERO;

        await tx
          .update(factoryMixBatches)
          .set({
            totalWeightKg: newTotalKg.toFixed(3),
            totalCost: newTotalCost.toFixed(7),
            costPerKg: newCostPerKg.toFixed(7),
            updatedAt: new Date(),
          })
          .where(eq(factoryMixBatches.id, batchId));
      });

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting batch source:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE a container raw stock receipt (only if no kg has been used yet)
  app.delete("/api/factory/raw-stock/receipts/:rawStockId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rawStockId = parseId(req.params.rawStockId);

      if (rawStockId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(rawStockId)) return res.status(400).json({ message: "Invalid rawStockId" });

      const [row] = await db
        .select()
        .from(factoryRawStock)
        .where(and(eq(factoryRawStock.id, rawStockId), eq(factoryRawStock.companyId, companyId)))
        .limit(1);
      if (!row) return res.status(404).json({ message: "Raw stock record not found" });

      const usedKg = toMoney(row.usedKg);
      if (usedKg.gt("0.001")) {
        return res.status(400).json({
          message: `Cannot delete: ${usedKg.toFixed(3)} kg have already been used from this receipt in batches. Delete the batch sources first or edit the balance instead.`,
        });
      }

      await db.transaction(async (tx) => {
        // Soft-delete the raw stock record
        await tx
          .update(factoryRawStock)
          .set({ deletedAt: new Date() })
          .where(and(eq(factoryRawStock.id, rawStockId), eq(factoryRawStock.companyId, companyId)));
        // Wave 14: a commission held on this row leaves the ledger with it.
        if (toMoney(row.commissionAmount ?? 0).greaterThan(0)) {
          await syncContainerCommissionJournalTx(tx, companyId, row.containerId);
        }

        // Delete linked OFFLOAD_RAW_STOCK daybook entry
        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "OFFLOAD_RAW_STOCK"),
              eq(factoryDaybookEntries.referenceId, rawStockId)
            )
          );
      });

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting raw stock receipt:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH update receivedKg on a container raw stock record (fixes balance going forward)
  app.patch("/api/factory/raw-stock/receipts/:rawStockId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rawStockId = parseId(req.params.rawStockId);

      if (rawStockId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(rawStockId)) return res.status(400).json({ message: "Invalid rawStockId" });

      const { receivedKg } = req.body;
      const newKg = parseMoneyInput(receivedKg);
      if (newKg === null || newKg.lt(0))
        return res.status(400).json({ message: "receivedKg must be a non-negative number" });

      const [row] = await db
        .select()
        .from(factoryRawStock)
        .where(and(eq(factoryRawStock.id, rawStockId), eq(factoryRawStock.companyId, companyId)))
        .limit(1);
      if (!row) return res.status(404).json({ message: "Raw stock record not found" });

      const usedKg = toMoney(row.usedKg);
      if (newKg.lt(usedKg.minus("0.001"))) {
        return res.status(400).json({
          message: `Cannot set receivedKg below already-used amount (${usedKg.toFixed(3)} kg used). Delete the batch sources first or set a higher value.`,
        });
      }

      await db
        .update(factoryRawStock)
        .set({ receivedKg: String(newKg.toNumber()) })
        .where(and(eq(factoryRawStock.id, rawStockId), eq(factoryRawStock.companyId, companyId)));

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error updating raw stock receipt:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/raw-stock/by-container", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const results = await db
        .select({
          id: factoryRawStock.id,
          companyId: factoryRawStock.companyId,
          containerId: factoryRawStock.containerId,
          receivedKg: factoryRawStock.receivedKg,
          usedKg: factoryRawStock.usedKg,
          costPerKg: factoryRawStock.costPerKg,
          costPerKgUsd: factoryRawStock.costPerKgUsd,
          offloadedAt: factoryRawStock.offloadedAt,
          createdAt: factoryRawStock.createdAt,
          containerNumber: factoryContainers.containerNumber,
          containerStatus: factoryContainers.status,
          supplierName: factorySuppliers.name,
          supplierId: factoryContainers.supplierId,
          origin: factoryContainers.origin,
        })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
        .where(
          and(
            eq(factoryRawStock.companyId, companyId),
            sql`${factoryContainers.status} != 'DELETED'`,
            isNull(factoryRawStock.deletedAt),
            isNull(factoryContainers.deletedAt)
          )
        );

      const enriched = results.map((r) => {
        const remainingKg = toMoney(r.receivedKg).minus(toMoney(r.usedKg));
        return { ...r, remainingKg: remainingKg.toFixed(3) };
      });

      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching factory raw stock by container:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/raw-stock/available-containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Include containers in statuses that can accept a first offload:
      // PENDING: created/ordered (user may offload directly from this state).
      // ARRIVED/RECEIVED: awaiting first offload.
      // PARTIALLY_RECEIVED is fetched here for the locked-cost lookup below but
      // is excluded from the response — continuation offloads are handled separately.
      // Exclude IN_TRANSIT, CLOSED, COMPLETED, OFFLOADED, DELETED, OPENING_BALANCE.
      const rawResults = await db
        .select()
        .from(factoryContainers)
        .where(
          and(
            eq(factoryContainers.companyId, companyId),
            sql`${factoryContainers.status} IN ('PENDING', 'ARRIVED', 'RECEIVED', 'PARTIALLY_RECEIVED')`,
            isNull(factoryContainers.deletedAt)
          )
        );

      // Strip out PARTIALLY_RECEIVED from the final response — those containers
      // already had their first receipt and should not appear in the first-offload
      // dropdown. Also guard against edge-case fully-received partials.
      const validContainers = rawResults.filter((c) => {
        if (c.status === "PARTIALLY_RECEIVED") return false;
        return true;
      });

      // For PARTIALLY_RECEIVED containers, surface the fixed landed cost/kg from
      // raw stock so the offload dialog can display the established rate without
      // requiring the user to re-enter it.
      const partialIds = validContainers.filter((c) => c.status === "PARTIALLY_RECEIVED").map((c) => c.id);
      const rawStockByContainer = new Map<number, { costPerKg: string | null; costPerKgUsd: string | null }>();

      if (partialIds.length > 0) {
        const rawStockRows = await db
          .select({
            containerId: factoryRawStock.containerId,
            costPerKg: factoryRawStock.costPerKg,
            costPerKgUsd: factoryRawStock.costPerKgUsd,
          })
          .from(factoryRawStock)
          .where(
            and(
              eq(factoryRawStock.companyId, companyId),
              inArray(factoryRawStock.containerId, partialIds),
              isNull(factoryRawStock.deletedAt)
            )
          );
        for (const row of rawStockRows) {
          rawStockByContainer.set(row.containerId, {
            costPerKg: row.costPerKg,
            costPerKgUsd: row.costPerKgUsd,
          });
        }
      }

      const response = validContainers.map((c) => {
        if (c.status !== "PARTIALLY_RECEIVED") return c;
        const rs = rawStockByContainer.get(c.id);
        return { ...c, fixedCostPerKg: rs?.costPerKg || null, fixedCostPerKgUsd: rs?.costPerKgUsd || null };
      });

      res.json(response);
    } catch (error: unknown) {
      logger.error("Error fetching available containers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
