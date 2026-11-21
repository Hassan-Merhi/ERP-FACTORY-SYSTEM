// Extracted from ./creditNoteRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage, HttpError } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../lib/inventoryMath";
import { db } from "../db";
import { assertZmwImportPrices, PosZmwRateError, resolveLockedZmwPosCurrency } from "../services/pos/posZmwRatePolicy";
import { getOrCreateInventoryControlAccount } from "../services/accounting/inventoryControlAccount";
import { requireAuth, requireNonPOS } from "../auth";
import { logAudit } from "./_helpers";
import { creditNoteItems, locations, stockItems, voucherEntries, vouchers } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { applyNoteLineInventoryTx, postNoteRevaluationTx } from "../services/inventory/creditNoteInventory";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";
import { allocateVoucherNumberTx } from "../services/accounting/voucherNumbering";
import {
  canonicalStockMovementAdapter,
  getOrCreateSalesReturnsAccount,
  normEntryAmounts,
} from "./getOrCreateSalesReturnsAccount";

export function registerCreditNoteRoutesPart1(app: Express) {
  app.post("/api/credit-notes", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { noteType, voucherDate, cashAccountId, cashAccountType, description, items, currency, exchangeRate } =
        req.body;
      if (!noteType || !["Credit Note", "Debit Note"].includes(noteType)) {
        return res.status(400).json({ message: "Invalid note type. Must be 'Credit Note' or 'Debit Note'" });
      }
      if (!voucherDate) return res.status(400).json({ message: "Voucher date is required" });
      if (!cashAccountId || !cashAccountType) return res.status(400).json({ message: "Cash/Bank account is required" });
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }

      for (const item of items) {
        if (!item.stockItemId || isNaN(Number(item.stockItemId))) {
          return res.status(400).json({ message: `Invalid stockItemId: ${item.stockItemId}` });
        }
        if (!item.locationId || isNaN(Number(item.locationId))) {
          return res
            .status(400)
            .json({ message: `Invalid locationId for item ${item.stockItemId}: ${item.locationId}` });
        }
        const qty = toInventoryDecimal(item.quantity);
        if (!qty.isFinite() || !qty.isPositive()) {
          return res.status(400).json({ message: `Invalid quantity for item ${item.stockItemId}: ${item.quantity}` });
        }
      }

      const lockedPosCurrency = await resolveLockedZmwPosCurrency(companyId, voucherDate, currency, exchangeRate);
      assertZmwImportPrices(
        items.map((item: { refundRate: unknown; originalCurrencyRate?: unknown }) => ({
          rate: item.refundRate,
          originalCurrencyRate: item.originalCurrencyRate,
        })),
        lockedPosCurrency
      );

      let totalRefundAmount = toInventoryDecimal(0);
      let totalInventoryValue = toInventoryDecimal(0);
      for (const item of items) {
        const qty = toInventoryDecimal(item.quantity);
        const refundRate = toInventoryDecimal(item.refundRate || item.rate);
        const inventoryCost = toInventoryDecimal(item.inventoryCost || item.rate);
        if (!qty.isPositive()) return res.status(400).json({ message: "Invalid quantity for item" });
        if (refundRate.isNegative()) return res.status(400).json({ message: "Invalid refund rate for item" });
        totalRefundAmount = addInventoryValues(totalRefundAmount, multiplyInventoryValues(qty, refundRate));
        totalInventoryValue = addInventoryValues(totalInventoryValue, multiplyInventoryValues(qty, inventoryCost));
      }

      const voucher = await db.transaction(async (tx) => {
        // Phase 22 (B), PE8: the gapless number (CN-/DN-<company>-YYYY-000001).
        // The lines stay direct writes: the inventory lines are the value the
        // sub-ledger moved, known only after the stock movements, which are
        // keyed by this voucher's id (listed in the phase 22 B wave log).
        const voucherNumber = await allocateVoucherNumberTx(tx, { companyId, voucherType: noteType, voucherDate });
        const [createdVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: noteType,
            voucherDate,
            description: description || `${noteType} for customer return`,
            totalAmount: inventoryMoney(totalRefundAmount),
            currency: lockedPosCurrency.currency,
            exchangeRate: lockedPosCurrency.exchangeRate,
          })
          .returning();

        const cashDebit = noteType === "Debit Note" ? totalRefundAmount : toInventoryDecimal(0);
        const cashCredit = noteType === "Credit Note" ? totalRefundAmount : toInventoryDecimal(0);
        if (cashAccountType === "bank") {
          await tx.insert(voucherEntries).values({
            voucherId: createdVoucher.id,
            bankAccountId: cashAccountId,
            ...normEntryAmounts(cashDebit, cashCredit, lockedPosCurrency),
            narration: `${noteType} - cash ${noteType === "Credit Note" ? "refund" : "receipt"}`,
          });
        } else {
          await tx.insert(voucherEntries).values({
            voucherId: createdVoucher.id,
            ledgerAccountId: cashAccountId,
            ...normEntryAmounts(cashDebit, cashCredit, lockedPosCurrency),
            narration: `${noteType} - cash ${noteType === "Credit Note" ? "refund" : "receipt"}`,
          });
        }

        // Resolve once per note. The old route queried for an account inside the
        // item loop and silently skipped the inventory leg when none existed,
        // which produced live unbalanced Credit/Debit Notes.
        const inventoryAccount = await getOrCreateInventoryControlAccount(tx, companyId);
        let documentValue = toInventoryDecimal(0);
        let subLedgerValue = toInventoryDecimal(0);

        for (const item of items) {
          const {
            stockItemId,
            locationId,
            quantity,
            refundRate: itemRefundRate,
            inventoryCost: itemInventoryCost,
          } = item;
          const qty = toInventoryDecimal(quantity);
          const refundRateVal = toInventoryDecimal(itemRefundRate);
          const inventoryCostVal = toInventoryDecimal(itemInventoryCost);
          const inventoryValue = multiplyInventoryValues(qty, inventoryCostVal);

          const [location] = await tx
            .select()
            .from(locations)
            .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId)));
          if (!location) throw new Error(`Location ${locationId} not found`);

          // Wave 11: the note's Inventory line is the value the sub-ledger moved.
          const moved = await applyNoteLineInventoryTx(tx, {
            companyId,
            noteType,
            voucherId: createdVoucher.id,
            locationId,
            stockItemId,
            quantity: qty,
            inventoryCost: inventoryCostVal,
          });
          subLedgerValue = subLedgerValue.plus(moved.valueMoved);

          if (!qty.isZero()) {
            await postStockMovementTx(
              tx,
              {
                companyId,
                stockItemId,
                kind: noteType === "Credit Note" ? "receipt" : "issue",
                quantity: inventoryQuantity(qty),
                unitCost: inventoryUnitCost(inventoryCostVal),
                fromLocationId: noteType === "Credit Note" ? null : locationId,
                toLocationId: noteType === "Credit Note" ? locationId : null,
                occurredAt: new Date().toISOString(),
                source: {
                  sourceType: noteType === "Credit Note" ? "credit-note" : "debit-note",
                  sourceId: String(createdVoucher.id),
                  idempotencyKey: `${noteType === "Credit Note" ? "credit-note" : "debit-note"}:${createdVoucher.id}:${stockItemId}:${locationId}`,
                },
                allowNegativeStock: true,
              },
              canonicalStockMovementAdapter
            );
          }

          documentValue = addInventoryValues(documentValue, inventoryValue);
          await tx.insert(voucherEntries).values({
            voucherId: createdVoucher.id,
            ledgerAccountId: inventoryAccount.id,
            ...normEntryAmounts(
              noteType === "Credit Note" ? moved.valueMoved : 0,
              noteType === "Debit Note" ? moved.valueMoved : 0
            ),
            narration: `Inventory ${noteType === "Credit Note" ? "restored" : "reduced"} - ${noteType}`,
          });

          await tx.insert(creditNoteItems).values({
            voucherId: createdVoucher.id,
            stockItemId,
            locationId,
            quantity: inventoryQuantity(qty),
            rate: inventoryUnitCost(refundRateVal),
            inventoryCost: inventoryUnitCost(inventoryCostVal),
            totalValue: inventoryMoney(multiplyInventoryValues(qty, refundRateVal)),
            valueMoved: inventoryMoney(moved.valueMoved),
          });
        }
        await postNoteRevaluationTx(tx, {
          companyId,
          noteType,
          voucherId: createdVoucher.id,
          documentValue,
          subLedgerValue,
          entryAmounts: normEntryAmounts,
        });

        const variance = subtractInventoryValues(totalRefundAmount, totalInventoryValue);
        // Include an exact one-cent difference: the deferred voucher guard requires balanced entries.
        if (variance.abs().greaterThanOrEqualTo("0.01")) {
          const salesReturnsAccountId = await getOrCreateSalesReturnsAccount(companyId, tx);
          if (salesReturnsAccountId) {
            const debit =
              noteType === "Credit Note"
                ? variance.isPositive()
                  ? variance
                  : toInventoryDecimal(0)
                : variance.isNegative()
                  ? variance.abs()
                  : toInventoryDecimal(0);
            const credit =
              noteType === "Credit Note"
                ? variance.isNegative()
                  ? variance.abs()
                  : toInventoryDecimal(0)
                : variance.isPositive()
                  ? variance
                  : toInventoryDecimal(0);
            await tx.insert(voucherEntries).values({
              voucherId: createdVoucher.id,
              ledgerAccountId: salesReturnsAccountId,
              ...normEntryAmounts(debit, credit),
              narration:
                noteType === "Credit Note"
                  ? "Variance between refund and inventory cost"
                  : "Variance between debit note amount and inventory cost",
            });
          }
        }

        // Wave 16 (B): audited in the creating transaction.
        const auditItems = await tx
          .select({
            stockItemId: creditNoteItems.stockItemId,
            stockItemName: stockItems.name,
            code: stockItems.code,
            sourceLocationId: creditNoteItems.locationId,
            sourceLocationName: locations.name,
            quantity: creditNoteItems.quantity,
            rate: creditNoteItems.rate,
            totalAmount: creditNoteItems.totalValue,
          })
          .from(creditNoteItems)
          .leftJoin(stockItems, eq(creditNoteItems.stockItemId, stockItems.id))
          .leftJoin(locations, eq(creditNoteItems.locationId, locations.id))
          .where(eq(creditNoteItems.voucherId, createdVoucher.id));

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "create",
            tableName: "vouchers",
            recordId: createdVoucher.id,
            recordIdentifier: createdVoucher.voucherNumber,
            changes: {
              voucherType: { old: null, new: noteType },
              date: { old: null, new: voucherDate },
              totalAmount: { old: null, new: inventoryMoney(totalRefundAmount) },
              itemCount: { old: null, new: auditItems.length },
              items: { new: auditItems },
              cashAccount: { old: null, new: cashAccountId },
            },
          },
          tx
        );

        return createdVoucher;
      });

      res.json({
        success: true,
        voucherId: voucher.id,
        voucherNumber: voucher.voucherNumber,
        message: `${noteType} created successfully`,
      });
    } catch (error: unknown) {
      if (error instanceof PosZmwRateError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message });
      }
      logger.error("Credit/Debit note error:", { error });
      res.status(error instanceof HttpError ? error.statusCode : 500).json({ message: getErrorMessage(error) });
    }
  });
}
