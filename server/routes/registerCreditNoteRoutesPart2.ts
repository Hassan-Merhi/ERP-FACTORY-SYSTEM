// Extracted from ./creditNoteRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { toInventoryDecimal } from "../lib/inventoryMath";
import { db } from "../db";
import { requireAuth } from "../auth";
import {
  containerOffloadItems,
  creditNoteItems,
  inventory,
  ledgerAccounts,
  locations,
  stockItems,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";

export function registerCreditNoteRoutesPart2(app: Express) {
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
          currency: voucher.currency,
          exchangeRate: voucher.exchangeRate,
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
}
