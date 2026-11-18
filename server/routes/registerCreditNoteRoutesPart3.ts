// Extracted from ./creditNoteRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import type Decimal from "decimal.js";
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
import { assertZmwImportPrices, type LockedPosCurrency, PosZmwRateError } from "../services/pos/posZmwRatePolicy";
import { getOrCreateInventoryControlAccount } from "../services/accounting/inventoryControlAccount";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { buildItemLevelChanges } from "./_helpers";
import { creditNoteItems, locations, voucherEntries, vouchers } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import {
  applyNoteLineInventoryTx,
  type NoteType,
  postNoteRevaluationTx,
  reverseNoteLineInventoryTx,
} from "../services/inventory/creditNoteInventory";
import { inventoryLedgerNetTx, postReversalResidualTx, sumDecimals } from "../services/inventory/valueExactReversal";
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../services/accounting/voucherCorrection";
import { rebalanceVoucherRoundingTx } from "../services/accounting/engineRounding";
import {
  getOrCreateSalesReturnsAccount,
  normEntryAmounts,
  type CreditNoteItemInput,
} from "./getOrCreateSalesReturnsAccount";

export function registerCreditNoteRoutesPart3(app: Express) {
  app.patch("/api/credit-notes/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const voucherId = parseInt(req.params.id);
      if (isNaN(voucherId)) return res.status(400).json({ message: "Invalid credit note ID" });

      const { voucherDate, cashAccountId, cashAccountType, description, items, currency, exchangeRate } = req.body;
      const [voucher] = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)));
      if (!voucher) return res.status(404).json({ message: "Credit note not found" });

      // A historic Kwacha refund keeps the rate originally recorded on this
      // note. Editing its date/currency would require a reversal and rebook.
      const wasZmw = voucher.currency === "ZMW";
      if (wasZmw && voucherDate && voucherDate !== String(voucher.voucherDate)) {
        return res.status(409).json({
          code: "ZMW_REFUND_DATE_LOCKED",
          message: "Reverse and rebook to change the date of a Kwacha refund.",
        });
      }
      if (
        wasZmw &&
        ((currency !== undefined && currency !== "ZMW") ||
          (exchangeRate != null && !toInventoryDecimal(exchangeRate).eq(voucher.exchangeRate || "0")))
      ) {
        return res.status(409).json({
          code: "ZMW_REFUND_RATE_LOCKED",
          message: "Cannot change the original Kwacha refund currency or locked rate.",
        });
      }
      if (!wasZmw && currency === "ZMW") {
        return res
          .status(409)
          .json({ code: "REFUND_CURRENCY_LOCKED", message: "Cannot change an existing refund's currency to ZMW." });
      }
      if (wasZmw && !voucher.exchangeRate) {
        return res
          .status(409)
          .json({ code: "ZMW_REFUND_RATE_MISSING", message: "Original ZMW refund has no locked exchange rate." });
      }
      const lockedPosCurrency: LockedPosCurrency = {
        currency: voucher.currency || "USD",
        exchangeRate: voucher.exchangeRate == null ? null : String(voucher.exchangeRate),
      };
      if (wasZmw) {
        assertZmwImportPrices(
          items.map((item: { refundRate: unknown; originalCurrencyRate?: unknown }) => ({
            rate: item.refundRate,
            originalCurrencyRate: item.originalCurrencyRate,
          })),
          lockedPosCurrency
        );
      }

      const noteType = voucher.voucherType;
      if (!["Credit Note", "Debit Note"].includes(noteType || "")) {
        return res.status(400).json({ message: "Not a credit/debit note" });
      }

      if (items && Array.isArray(items)) {
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
      }

      const oldItems = await db.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, voucherId));

      await db.transaction(async (tx) => {
        // Phase 22 (B), PE9/G4: open-period edit, audited below; closed period → 409.
        const editContext = await assertVoucherEditableTx(tx, voucherId, {
          companyId,
          newVoucherDate: voucherDate ?? null,
        });
        const existingItems = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, voucherId));
        // Wave 11: the old lines move back exactly their value_moved.
        const ledgerBefore = await inventoryLedgerNetTx(tx, companyId, [voucherId]);
        const subLedgerDeltas: Decimal[] = [];
        for (const item of existingItems) {
          subLedgerDeltas.push(
            await reverseNoteLineInventoryTx(tx, {
              companyId,
              noteType: noteType as NoteType,
              voucherId,
              line: item,
            })
          );
        }

        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
        await tx.delete(creditNoteItems).where(eq(creditNoteItems.voucherId, voucherId));

        let totalRefundAmount = toInventoryDecimal(0);
        let totalInventoryValue = toInventoryDecimal(0);
        for (const item of items) {
          const qty = toInventoryDecimal(item.quantity);
          const refundRate = toInventoryDecimal(item.refundRate);
          const inventoryCost = toInventoryDecimal(item.inventoryCost);
          totalRefundAmount = addInventoryValues(totalRefundAmount, multiplyInventoryValues(qty, refundRate));
          totalInventoryValue = addInventoryValues(totalInventoryValue, multiplyInventoryValues(qty, inventoryCost));
        }

        await tx
          .update(vouchers)
          .set({
            voucherDate,
            description: description || voucher.description,
            totalAmount: inventoryMoney(totalRefundAmount),
          })
          .where(eq(vouchers.id, voucherId));

        const cashDebit = noteType === "Debit Note" ? totalRefundAmount : toInventoryDecimal(0);
        const cashCredit = noteType === "Credit Note" ? totalRefundAmount : toInventoryDecimal(0);
        if (cashAccountType === "bank") {
          await tx.insert(voucherEntries).values({
            voucherId,
            bankAccountId: cashAccountId,
            ...normEntryAmounts(cashDebit, cashCredit, lockedPosCurrency),
            narration: `${noteType} - cash ${noteType === "Credit Note" ? "refund" : "receipt"}`,
          });
        } else {
          await tx.insert(voucherEntries).values({
            voucherId,
            ledgerAccountId: cashAccountId,
            ...normEntryAmounts(cashDebit, cashCredit, lockedPosCurrency),
            narration: `${noteType} - cash ${noteType === "Credit Note" ? "refund" : "receipt"}`,
          });
        }

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

          const moved = await applyNoteLineInventoryTx(tx, {
            companyId,
            noteType: noteType as NoteType,
            voucherId,
            locationId,
            stockItemId,
            quantity: qty,
            inventoryCost: inventoryCostVal,
          });
          subLedgerValue = subLedgerValue.plus(moved.valueMoved);
          subLedgerDeltas.push(moved.delta);
          documentValue = addInventoryValues(documentValue, inventoryValue);

          await tx.insert(voucherEntries).values({
            voucherId,
            ledgerAccountId: inventoryAccount.id,
            ...normEntryAmounts(
              noteType === "Credit Note" ? moved.valueMoved : 0,
              noteType === "Debit Note" ? moved.valueMoved : 0
            ),
            narration: `Inventory ${noteType === "Credit Note" ? "restored" : "reduced"} - ${noteType}`,
          });

          await tx.insert(creditNoteItems).values({
            voucherId,
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
          noteType: noteType as NoteType,
          voucherId,
          documentValue,
          subLedgerValue,
          entryAmounts: normEntryAmounts,
        });

        const variance = subtractInventoryValues(totalRefundAmount, totalInventoryValue);
        if (variance.abs().greaterThan("0.01")) {
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
              voucherId,
              ledgerAccountId: salesReturnsAccountId,
              ...normEntryAmounts(debit, credit),
              narration:
                noteType === "Credit Note"
                  ? "Variance between refund and inventory cost"
                  : "Variance between debit note amount and inventory cost",
            });
          }
        }

        // The ledger must move with the sub-ledger: an old line that could not
        // move back its whole value (the stock was sold since) is posted as a
        // reversal difference.
        await postReversalResidualTx(tx, {
          companyId,
          sourceType: "credit-note-edit",
          sourceId: `${voucherId}:${Date.now().toString(36)}`,
          reference: voucher.voucherNumber,
          subLedgerDelta: sumDecimals(subLedgerDeltas),
          ledgerDelta: (await inventoryLedgerNetTx(tx, companyId, [voucherId])).minus(ledgerBefore),
          actor: { userId: req.session.userId!, username: req.session.username || "unknown" },
        });

        // Phase 22 A (D3): the rounding remainder of an engine voucher's new lines.
        await rebalanceVoucherRoundingTx(tx, { companyId, voucherId });
        // Wave 16 (B): audited in the editing transaction.
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        if (voucherDate && voucher.voucherDate !== voucherDate)
          changes.date = { old: voucher.voucherDate, new: voucherDate };
        if (cashAccountId !== undefined)
          changes.cashAccount = { old: oldItems[0]?.voucherId ?? null, new: cashAccountId };
        const resolveName = async (id: number) => (await storage.getStockItemById(id))?.name ?? `Item #${id}`;
        const itemDiff = items?.length
          ? await buildItemLevelChanges(
              oldItems.map((it) => ({
                stockItemId: it.stockItemId,
                quantity: it.quantity,
                rate: it.rate,
                totalValue: it.totalValue,
              })),
              (items as CreditNoteItemInput[]).map((it) => ({
                stockItemId: Number(it.stockItemId),
                quantity: String(it.quantity ?? ""),
                rate: String(it.refundRate ?? it.rate ?? ""),
                totalValue: inventoryMoney(
                  multiplyInventoryValues(
                    it.quantity as string | number | null | undefined,
                    (it.refundRate ?? it.rate) as string | number | null | undefined
                  )
                ),
              })),
              resolveName
            )
          : {};
        // Phase 22 (B): one row — the correction policy's full before/after
        // snapshot with the readable note changes.
        await recordVoucherEditAuditTx(tx, {
          voucherId,
          before: editContext.before,
          actor: { userId: req.session.userId, username: req.session.username, companyId },
          reason: `${noteType} edit`,
          extra: { ...changes, ...itemDiff },
        });
      });

      res.json({ success: true, voucherId, message: `${noteType} updated successfully` });
    } catch (error: unknown) {
      if (error instanceof PosZmwRateError) {
        return res.status(error.statusCode).json({ code: error.code, message: error.message });
      }
      logger.error("Update credit note error:", { error });
      if (sendVoucherCorrectionRefusal(res, error)) return;
      res.status(error instanceof HttpError ? error.statusCode : 500).json({ message: getErrorMessage(error) });
    }
  });
}
