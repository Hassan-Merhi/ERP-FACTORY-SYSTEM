import type { Express } from "express";
import type Decimal from "decimal.js";
import { getErrorMessage } from "../lib/httpHandlers";
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
import { normalizeVoucherEntryAmounts } from "../services/accounting/currencyAmounts";
import { storage } from "../storage";
import { requireAuth, requireNonPOS } from "../auth";
import { logAudit, buildItemLevelChanges } from "./_helpers";
import {
  inventory,
  stockItems,
  containerOffloadItems,
  vouchers,
  voucherEntries,
  locations,
  ledgerAccounts,
  creditNoteItems,
} from "@shared/schema";
import { eq, and, or, desc, ilike } from "drizzle-orm";
import { adjustInventory } from "../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";

async function getOrCreateSalesReturnsAccount(companyId: number, txOrDb: any = db): Promise<number | null> {
  const byName = await txOrDb
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        or(ilike(ledgerAccounts.name, "%sales return%"), ilike(ledgerAccounts.name, "%return%allowance%"))
      )
    )
    .limit(1);
  if (byName.length > 0) return byName[0].id;

  const byCode = await txOrDb
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "SALES-RETURNS")))
    .limit(1);
  if (byCode.length > 0) return byCode[0].id;

  const [created] = await txOrDb
    .insert(ledgerAccounts)
    .values({
      companyId,
      code: "SALES-RETURNS",
      name: "Sales Returns & Allowances",
      accountType: "Income",
      active: true,
      isHidden: false,
    })
    .returning({ id: ledgerAccounts.id });
  return created?.id ?? null;
}

function normEntryAmounts(debit: Decimal.Value, credit: Decimal.Value): Record<string, string> {
  const dStr = toInventoryDecimal(debit).toFixed(6);
  const cStr = toInventoryDecimal(credit).toFixed(6);
  try {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: "USD",
      baseCurrency: "USD",
      transactionDebitAmount: dStr,
      transactionCreditAmount: cStr,
      historicalRate: "1",
    });
    return {
      debitAmount: norm.debitAmount,
      creditAmount: norm.creditAmount,
      transactionCurrency: norm.transactionCurrency,
      transactionDebitAmount: norm.transactionDebitAmount,
      transactionCreditAmount: norm.transactionCreditAmount,
      baseDebitAmount: norm.baseDebitAmount,
      baseCreditAmount: norm.baseCreditAmount,
      historicalExchangeRate: norm.historicalExchangeRate,
      rateConvention: norm.rateConvention,
    };
  } catch {
    return { debitAmount: inventoryMoney(debit), creditAmount: inventoryMoney(credit) };
  }
}

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerCreditNoteRoutes(app: Express) {
  app.post("/api/credit-notes", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { noteType, voucherDate, cashAccountId, cashAccountType, description, items } = req.body;
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

      const timestamp = Date.now();
      const prefix = noteType === "Credit Note" ? "CN" : "DN";
      const voucherNumber = `${prefix}-${timestamp}`;

      const voucher = await db.transaction(async (tx) => {
        const [createdVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherNumber,
            voucherType: noteType,
            voucherDate,
            description: description || `${noteType} for customer return`,
            totalAmount: inventoryMoney(totalRefundAmount),
          })
          .returning();

        const cashDebit = noteType === "Debit Note" ? totalRefundAmount : toInventoryDecimal(0);
        const cashCredit = noteType === "Credit Note" ? totalRefundAmount : toInventoryDecimal(0);
        if (cashAccountType === "bank") {
          await tx.insert(voucherEntries).values({
            voucherId: createdVoucher.id,
            bankAccountId: cashAccountId,
            ...normEntryAmounts(cashDebit, cashCredit),
            narration: `${noteType} - cash ${noteType === "Credit Note" ? "refund" : "receipt"}`,
          });
        } else {
          await tx.insert(voucherEntries).values({
            voucherId: createdVoucher.id,
            ledgerAccountId: cashAccountId,
            ...normEntryAmounts(cashDebit, cashCredit),
            narration: `${noteType} - cash ${noteType === "Credit Note" ? "refund" : "receipt"}`,
          });
        }

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

          const [location] = await tx.select().from(locations).where(eq(locations.id, locationId));
          if (!location) throw new Error(`Location ${locationId} not found`);

          if (noteType === "Credit Note") {
            await adjustInventory(tx, locationId, stockItemId, qty.toNumber(), companyId);
          } else {
            await adjustInventory(tx, locationId, stockItemId, qty.negated().toNumber(), companyId);
          }

          // Canonical evidence for the return, on the same transaction that
          // moved the stock. A credit note takes a customer's goods back into
          // the location; a debit note sends goods back out to a supplier. The
          // unit cost is the inventory cost the note itself carries, which is
          // what the accounting entries below are built from.
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

          const inventoryAccount = await tx
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                or(ilike(ledgerAccounts.name, "%inventory%"), ilike(ledgerAccounts.name, "%stock in hand%"))
              )
            )
            .limit(1);

          if (inventoryAccount.length > 0) {
            await tx.insert(voucherEntries).values({
              voucherId: createdVoucher.id,
              ledgerAccountId: inventoryAccount[0].id,
              ...normEntryAmounts(
                noteType === "Credit Note" ? inventoryValue : 0,
                noteType === "Debit Note" ? inventoryValue : 0
              ),
              narration: `Inventory ${noteType === "Credit Note" ? "restored" : "reduced"} - ${noteType}`,
            });
          }

          await tx.insert(creditNoteItems).values({
            voucherId: createdVoucher.id,
            stockItemId,
            locationId,
            quantity: inventoryQuantity(qty),
            rate: inventoryUnitCost(refundRateVal),
            inventoryCost: inventoryUnitCost(inventoryCostVal),
            totalValue: inventoryMoney(multiplyInventoryValues(qty, refundRateVal)),
          });
        }

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

        return createdVoucher;
      });

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "create",
          tableName: "vouchers",
          recordId: voucher.id,
          recordIdentifier: voucher.voucherNumber,
          changes: {
            voucherType: { old: null, new: noteType },
            date: { old: null, new: voucherDate },
            totalAmount: { old: null, new: inventoryMoney(totalRefundAmount) },
            itemCount: { old: null, new: items.length },
            cashAccount: { old: null, new: cashAccountId },
          },
        });
      } catch {
        /* non-fatal */
      }

      res.json({
        success: true,
        voucherId: voucher.id,
        voucherNumber: voucher.voucherNumber,
        message: `${noteType} created successfully`,
      });
    } catch (error: unknown) {
      logger.error("Credit/Debit note error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/credit-notes/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const voucherId = parseInt(req.params.id);
      if (isNaN(voucherId)) return res.status(400).json({ message: "Invalid credit note ID" });

      const [voucher] = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)));
      if (!voucher) return res.status(404).json({ message: "Credit note not found" });
      if (!["Credit Note", "Debit Note"].includes(voucher.voucherType || "")) {
        return res.status(400).json({ message: "Not a credit/debit note" });
      }

      const entries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
      const noteItems = await db
        .select({
          id: creditNoteItems.id,
          stockItemId: creditNoteItems.stockItemId,
          locationId: creditNoteItems.locationId,
          quantity: creditNoteItems.quantity,
          rate: creditNoteItems.rate,
          totalValue: creditNoteItems.totalValue,
          stockItemName: stockItems.name,
          stockItemCode: stockItems.code,
          stockItemUom: stockItems.uom,
          locationName: locations.name,
        })
        .from(creditNoteItems)
        .leftJoin(stockItems, eq(creditNoteItems.stockItemId, stockItems.id))
        .leftJoin(locations, eq(creditNoteItems.locationId, locations.id))
        .where(eq(creditNoteItems.voucherId, voucherId));

      let cashAccountId = 0;
      let cashAccountType = "";
      for (const entry of entries) {
        if (entry.bankAccountId) {
          cashAccountId = entry.bankAccountId;
          cashAccountType = "bank";
          break;
        } else if (entry.ledgerAccountId) {
          const [ledger] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, entry.ledgerAccountId));
          if (ledger && ["Cash", "Bank"].includes(ledger.accountType || "")) {
            cashAccountId = entry.ledgerAccountId;
            cashAccountType = "ledger";
            break;
          }
        }
      }

      const itemsWithCosts = await Promise.all(
        noteItems.map(async (item) => {
          let costRate = "0";
          const [inv] = await db
            .select()
            .from(inventory)
            .where(and(eq(inventory.stockItemId, item.stockItemId), eq(inventory.locationId, item.locationId)));

          if (inv?.averageRate && toInventoryDecimal(inv.averageRate).isPositive()) {
            costRate = inv.averageRate;
          } else {
            const [anyInv] = await db
              .select()
              .from(inventory)
              .where(eq(inventory.stockItemId, item.stockItemId))
              .orderBy(desc(inventory.quantity))
              .limit(1);

            if (anyInv?.averageRate && toInventoryDecimal(anyInv.averageRate).isPositive()) {
              costRate = anyInv.averageRate;
            } else {
              const [offloadItem] = await db
                .select()
                .from(containerOffloadItems)
                .where(eq(containerOffloadItems.stockItemId, item.stockItemId))
                .orderBy(desc(containerOffloadItems.id))
                .limit(1);
              if (offloadItem?.rate && toInventoryDecimal(offloadItem.rate).isPositive()) costRate = offloadItem.rate;
            }
          }

          return {
            stockItemId: item.stockItemId,
            stockItemName: item.stockItemName || "",
            stockItemCode: item.stockItemCode || "",
            locationId: item.locationId,
            locationName: item.locationName || "",
            quantity: item.quantity,
            refundRate: item.rate,
            inventoryCost: costRate,
            uom: item.stockItemUom || "",
          };
        })
      );

      res.json({
        voucher: {
          id: voucher.id,
          voucherNumber: voucher.voucherNumber,
          voucherType: voucher.voucherType,
          voucherDate: voucher.voucherDate,
          description: voucher.description,
          totalAmount: voucher.totalAmount,
        },
        cashAccountId,
        cashAccountType,
        items: itemsWithCosts,
      });
    } catch (error: unknown) {
      logger.error("Get credit note error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/credit-notes/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const voucherId = parseInt(req.params.id);
      if (isNaN(voucherId)) return res.status(400).json({ message: "Invalid credit note ID" });

      const { voucherDate, cashAccountId, cashAccountType, description, items } = req.body;
      const [voucher] = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)));
      if (!voucher) return res.status(404).json({ message: "Credit note not found" });

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
        const existingItems = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, voucherId));
        for (const item of existingItems) {
          const qty = toInventoryDecimal(item.quantity);
          await adjustInventory(
            tx,
            item.locationId,
            item.stockItemId,
            (noteType === "Credit Note" ? qty.negated() : qty).toNumber(),
            companyId
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
            ...normEntryAmounts(cashDebit, cashCredit),
            narration: `${noteType} - cash ${noteType === "Credit Note" ? "refund" : "receipt"}`,
          });
        } else {
          await tx.insert(voucherEntries).values({
            voucherId,
            ledgerAccountId: cashAccountId,
            ...normEntryAmounts(cashDebit, cashCredit),
            narration: `${noteType} - cash ${noteType === "Credit Note" ? "refund" : "receipt"}`,
          });
        }

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

          const [location] = await tx.select().from(locations).where(eq(locations.id, locationId));
          if (!location) throw new Error(`Location ${locationId} not found`);

          await adjustInventory(
            tx,
            locationId,
            stockItemId,
            (noteType === "Credit Note" ? qty : qty.negated()).toNumber(),
            companyId
          );

          const inventoryAccount = await tx
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                or(ilike(ledgerAccounts.name, "%inventory%"), ilike(ledgerAccounts.name, "%stock in hand%"))
              )
            )
            .limit(1);

          if (inventoryAccount.length > 0) {
            await tx.insert(voucherEntries).values({
              voucherId,
              ledgerAccountId: inventoryAccount[0].id,
              ...normEntryAmounts(
                noteType === "Credit Note" ? inventoryValue : 0,
                noteType === "Debit Note" ? inventoryValue : 0
              ),
              narration: `Inventory ${noteType === "Credit Note" ? "restored" : "reduced"} - ${noteType}`,
            });
          }

          await tx.insert(creditNoteItems).values({
            voucherId,
            stockItemId,
            locationId,
            quantity: inventoryQuantity(qty),
            rate: inventoryUnitCost(refundRateVal),
            inventoryCost: inventoryUnitCost(inventoryCostVal),
            totalValue: inventoryMoney(multiplyInventoryValues(qty, refundRateVal)),
          });
        }

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
      });

      try {
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
              (items as any[]).map((it) => ({
                stockItemId: Number(it.stockItemId),
                quantity: String(it.quantity ?? ""),
                rate: String(it.refundRate ?? it.rate ?? ""),
                totalValue: inventoryMoney(multiplyInventoryValues(it.quantity, it.refundRate ?? it.rate)),
              })),
              resolveName
            )
          : {};
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId,
          action: "update",
          tableName: "vouchers",
          recordId: voucherId,
          recordIdentifier: voucher.voucherNumber,
          changes: { ...changes, ...itemDiff },
        });
      } catch {
        /* non-fatal */
      }

      res.json({ success: true, voucherId, message: `${noteType} updated successfully` });
    } catch (error: unknown) {
      logger.error("Update credit note error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
