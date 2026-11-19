// Extracted from ./rawStockAdjRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { withFactoryValuationEventTx } from "../../../services/factory/factoryStockValueEvents";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { validateRequest } from "../../../lib/validateRequest";
import { createAdjustmentInput, deleteAdjustmentInput } from "./rawStockWriteRouteSchemas";
import { getLockedSupplierRate } from "../../../services/factory/rawStockLockedRate";
import { getOrCreateLedgerAccount, writeDaybookEntry } from "../_helpers";
import {
  factoryContainers,
  factoryDaybookEntries,
  factoryRawMaterialAdjustments,
  factoryRawStock,
  factorySuppliers,
  vouchers,
} from "@shared/schema";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { postFactoryVoucherTx } from "../../../services/factory/factoryVoucherPosting";
import { factoryDocumentRate, FactoryFxRateRequiredError } from "../../../services/factory/factoryDocumentFxRate";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";
import { ZERO } from "./registerRawStockAdjRoutesPart1";

export function registerRawStockAdjRoutesPart2(app: Express) {
  // POST create a new adjustment (ADD or REMOVE), or create a new standalone manual material
  app.post(
    "/api/factory/raw-stock/adjustment",
    requireAuth,
    validateRequest(createAdjustmentInput),
    async (req: Request, res: Response) => {
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

            // Phase 22 (C): through the engine with the adjustment's posting
            // identity; the FACTORY-MANUAL-{adjustment}- number keeps its prefix with
            // the posting generation (was Date.now()). Both legs normalized at the
            // purchase's rate (wave 6): Dr Raw Material Stock / Cr Supplier.
            const adjustmentId = inserted.id;
            await postFactoryVoucherTx(tx, {
              companyId,
              voucherNumber: (generation) => `FACTORY-MANUAL-${adjustmentId}-${generation}`,
              voucherDate: date,
              description: `Manual raw material purchase: ${kgNum} kg @ ${costNum}/${ccy} — ${supplierName}`,
              currency: ccy,
              fxRateToUsd: fxRate,
              source: { sourceType: "factory-raw-material-purchase", sourceId: adjustmentId, phase: "voucher" },
              lines: [
                {
                  ledgerAccountId: rawMaterialAcctId,
                  debit: moneyString(totalAmount),
                  narration: `Raw material stock — ${kgNum} kg from ${supplierName}`,
                },
                {
                  factorySupplierId: resolvedSupplierId,
                  credit: moneyString(totalAmount),
                  narration: `Payable to ${supplierName} for raw material`,
                },
              ],
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
    }
  );

  // DELETE a specific adjustment
  app.delete(
    "/api/factory/raw-stock/adjustments/:id",
    requireAuth,
    validateRequest(deleteAdjustmentInput),
    async (req: Request, res: Response) => {
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
                    and(
                      eq(factoryRawMaterialAdjustments.id, id),
                      eq(factoryRawMaterialAdjustments.companyId, companyId)
                    )
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
    }
  );
}
