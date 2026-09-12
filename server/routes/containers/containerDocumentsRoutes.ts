import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { getClientDate } from "../../lib/dateUtils";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  inventory,
  stockItems,
  containerOffloads,
  containerOffloadItems,
  poLineItems,
  vouchers,
  voucherEntries,
  salesItems,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { createWorkbook, aoaToSheet, writeWorkbook } from "../../excelHelper";

export function registerContainerDocumentsRoutes(app: Express) {
  app.get("/api/containers/:id/export", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const containerId = parseId(req.params.id);

      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
       const container = await storage.getContainerByIdForCompany(containerId, req.session.currentCompanyId);

      if (!container) {
        return res.status(404).json({ message: "Container not found" });
      }

      const supplier = await storage.getSupplierById(container.supplierId);
       const purchaseOrders = await storage.getPurchaseOrdersByContainerForCompany(containerId, req.session.currentCompanyId);

      // Batch-fetch all PO line items and offload items in parallel
      const poIds = purchaseOrders.map((po) => po.id);
      const [[offloadRecord], allPoLineItems] = await Promise.all([
        db.select().from(containerOffloads).where(eq(containerOffloads.containerId, containerId)).limit(1).execute(),
        poIds.length > 0 ? db.select().from(poLineItems).where(inArray(poLineItems.poId, poIds)).execute() : [],
      ]);

      const poStockIds = [...new Set(allPoLineItems.map((li) => li.stockItemId).filter(Boolean) as number[])];
      const [offloadItems, poStockRows] = await Promise.all([
        offloadRecord
          ? db
              .select()
              .from(containerOffloadItems)
              .where(eq(containerOffloadItems.offloadId, offloadRecord.id))
              .execute()
          : [],
        poStockIds.length > 0
          ? db
              .select({ id: stockItems.id, code: stockItems.code, name: stockItems.name })
              .from(stockItems)
              .where(inArray(stockItems.id, poStockIds))
              .execute()
          : [],
      ]);

      const offloadStockIds = [...new Set(offloadItems.map((i) => i.stockItemId).filter(Boolean) as number[])];
      const offloadStockRows =
        offloadStockIds.length > 0
          ? await db
              .select({ id: stockItems.id, code: stockItems.code, name: stockItems.name })
              .from(stockItems)
              .where(inArray(stockItems.id, offloadStockIds))
              .execute()
          : [];

      const stockMap = new Map([...poStockRows, ...offloadStockRows].map((s) => [s.id, s]));
      const lineItemsByPO = new Map<number, typeof allPoLineItems>();
      for (const li of allPoLineItems) {
        const arr = lineItemsByPO.get(li.poId!) || [];
        arr.push(li);
        lineItemsByPO.set(li.poId!, arr);
      }

      const posWithItems = purchaseOrders.map((po) => {
        const lineItemsForPO = lineItemsByPO.get(po.id) || [];
        return {
          poNumber: po.poNumber,
          currency: po.currency,
          itemsTotal: po.itemsTotal,
          freight: po.freight,
          surcharge: po.surcharge,
          fumigation: po.fumigation,
          documentCharges: po.documentCharges,
          discount: po.discount,
          otherCharges: po.otherCharges,
          status: po.status,
          lineItems: lineItemsForPO.map((item) => {
            const stockItem = item.stockItemId ? stockMap.get(item.stockItemId) : null;
            return {
              stockItemCode: stockItem?.code || "",
              stockItemName: stockItem?.name || item.itemName,
              quantity: item.quantity,
              rate: item.rate,
              lineTotal: item.lineTotal,
            };
          }),
        };
      });

      let offloadDetails = null;
      if (offloadRecord) {
        const location = await storage.getLocationById(offloadRecord.locationId);
        offloadDetails = {
          locationName: location?.name || "",
          duties: offloadRecord.duties,
          officeCharges: offloadRecord.officeCharges,
          transferCharges: offloadRecord.transferCharges,
          transportFees: offloadRecord.transportFees,
          totalCharges: offloadRecord.totalCharges,
          totalBales: offloadRecord.totalBales,
          additionalCostPerBale: offloadRecord.additionalCostPerBale,
          offloadedAt: offloadRecord.offloadedAt,
          offloadItems: offloadItems.map((item) => {
            const stockItem = item.stockItemId ? stockMap.get(item.stockItemId) : null;
            return {
              stockItemCode: stockItem?.code || "",
              stockItemName: stockItem?.name || "",
              quantity: item.quantity,
              rate: item.rate,
              totalValue: item.totalValue,
            };
          }),
        };
      }

      const exportData = {
        exportDate: new Date().toISOString(),
        container: {
          containerNumber: container.containerNumber,
          supplierName: supplier?.legalName || "",
          numberPlate: container.numberPlate || "",
          status: container.status,
          importDate: container.importDate,
          itemsTotal: container.itemsTotal,
          chargesTotal: container.chargesTotal,
          grandTotal: container.grandTotal,
          itemName: container.itemName,
          ratePerKg: container.ratePerKg,
          totalKg: container.totalKg,
        },
        supplier: {
          code: supplier?.code || "",
          legalName: supplier?.legalName || "",
        },
        purchaseOrders: posWithItems,
        offload: offloadDetails,
      };

      res.json(exportData);
    } catch (error: unknown) {
      logger.error("Container export error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Export all containers as Excel (one sheet per container)
  app.get("/api/containers/export-all", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const allContainers = await storage.getAllContainers(req.session.currentCompanyId);
      const workbook = createWorkbook();

      for (const container of allContainers) {
        const supplier = await storage.getSupplierById(container.supplierId);
         const purchaseOrders = await storage.getPurchaseOrdersByContainerForCompany(
           container.id,
           req.session.currentCompanyId
         );

        const sheetData: unknown[][] = [];

        sheetData.push(["CONTAINER DETAILS"]);
        sheetData.push(["Container Number", container.containerNumber]);
        sheetData.push(["Supplier", supplier?.legalName || ""]);
        sheetData.push(["Status", container.status]);
        sheetData.push(["Import Date", container.importDate]);
        sheetData.push(["Items Total", container.itemsTotal]);
        sheetData.push(["Charges Total", container.chargesTotal]);
        sheetData.push(["Grand Total", container.grandTotal]);
        if (container.itemName) {
          sheetData.push(["Manual Item", container.itemName]);
          sheetData.push(["Rate/Kg", container.ratePerKg]);
          sheetData.push(["Total Kg", container.totalKg]);
        }
        sheetData.push([]);

        for (const po of purchaseOrders) {
          sheetData.push(["PURCHASE ORDER: " + po.poNumber]);
          sheetData.push(["Currency", po.currency]);
          sheetData.push(["Items Total", po.itemsTotal]);
          sheetData.push(["Freight", po.freight]);
          sheetData.push(["Surcharge", po.surcharge]);
          sheetData.push(["Fumigation", po.fumigation]);
          sheetData.push(["Document Charges", po.documentCharges]);
          sheetData.push(["Discount", po.discount]);
          sheetData.push(["Other Charges", po.otherCharges]);
          sheetData.push([]);

          const lineItems = await storage.getLineItemsByPO(po.id);
          if (lineItems.length > 0) {
            sheetData.push(["Stock Code", "Item Name", "Quantity", "Rate", "Line Total"]);
            for (const item of lineItems) {
              const stockItem = item.stockItemId ? await storage.getStockItemById(item.stockItemId) : null;
              sheetData.push([
                stockItem?.code || "",
                stockItem?.name || item.itemName,
                item.quantity,
                item.rate,
                item.lineTotal,
              ]);
            }
            sheetData.push([]);
          }
        }

        const [offloadRecord] = await db
          .select()
          .from(containerOffloads)
          .where(eq(containerOffloads.containerId, container.id))
          .limit(1);
        if (offloadRecord) {
          const location = await storage.getLocationById(offloadRecord.locationId);
          sheetData.push(["OFFLOAD DETAILS"]);
          sheetData.push(["Location", location?.name || ""]);
          sheetData.push(["Duties", offloadRecord.duties]);
          sheetData.push(["Office Charges", offloadRecord.officeCharges]);
          sheetData.push(["Transfer Charges", offloadRecord.transferCharges]);
          sheetData.push(["Transport Fees", offloadRecord.transportFees]);
          sheetData.push(["Total Charges", offloadRecord.totalCharges]);
          sheetData.push(["Total Bales", offloadRecord.totalBales]);
          sheetData.push(["Additional Cost/Bale", offloadRecord.additionalCostPerBale]);
          sheetData.push(["Offloaded At", offloadRecord.offloadedAt?.toISOString() || ""]);
          sheetData.push([]);

          const offloadItems = await db
            .select()
            .from(containerOffloadItems)
            .where(eq(containerOffloadItems.offloadId, offloadRecord.id));

          if (offloadItems.length > 0) {
            sheetData.push(["OFFLOAD ITEMS"]);
            sheetData.push(["Stock Code", "Item Name", "Quantity", "Rate", "Total Value"]);
            for (const item of offloadItems) {
              const stockItem = await storage.getStockItemById(item.stockItemId);
              sheetData.push([stockItem?.code || "", stockItem?.name || "", item.quantity, item.rate, item.totalValue]);
            }
          }
        }

        const sheetName = container.containerNumber.replace(/[\\/*?:[\]]/g, "_").substring(0, 31);
        aoaToSheet(workbook, sheetData, sheetName);
      }

      const buffer = await writeWorkbook(workbook);

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="containers_export_${getClientDate(req)}.xlsx"`);
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Container export-all error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Create a manual container (ERP only — SP companies must use /api/sp/containers)

  app.post("/api/sales-import/backfill", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { locationCashAccountMap } = req.body;

      if (!locationCashAccountMap || typeof locationCashAccountMap !== "object") {
        return res.status(400).json({
          message:
            "Location-to-cash-account mapping is required. Please specify which cash account to use for each location's sales.",
        });
      }

      // Validate all cash accounts belong to this company
      const cashAccountIds = Object.values(locationCashAccountMap) as number[];
      for (const cashAccountId of cashAccountIds) {
        const cashAccount = await storage.getLedgerAccountById(cashAccountId);
        if (!cashAccount || cashAccount.companyId !== req.session.currentCompanyId) {
          return res.status(400).json({ message: `Invalid cash account ID: ${cashAccountId}` });
        }
      }

      // Get or create "Sales Revenue" ledger account
      let salesRevenueAccount = await storage.getLedgerAccountByCode("SALES_REV", req.session.currentCompanyId!);
      if (!salesRevenueAccount) {
        salesRevenueAccount = await storage.createLedgerAccount({
          companyId: req.session.currentCompanyId!,
          code: "SALES_REV",
          name: "Sales Revenue",
          accountType: "Income",
          subType: "Direct Income",
          openingBalance: "0",
          openingBalanceSide: "Cr",
          active: true,
        });
      }

      // Get all Sales vouchers for this company
      const allVouchers = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.companyId, req.session.currentCompanyId!), eq(vouchers.voucherType, "Sales")))
        .execute();

      if (allVouchers.length === 0) {
        return res.json({
          message: "No sales vouchers found",
          count: 0,
        });
      }

      // Get all existing voucher entries for these vouchers
      const voucherIds = allVouchers.map((v) => v.id);
      const existingEntries = await db
        .select()
        .from(voucherEntries)
        .where(inArray(voucherEntries.voucherId, voucherIds))
        .execute();

      // Create a map of voucher ID -> set of ledger account IDs
      const voucherLedgerMap = new Map<number, Set<number>>();
      for (const entry of existingEntries) {
        if (!voucherLedgerMap.has(entry.voucherId)) {
          voucherLedgerMap.set(entry.voucherId, new Set());
        }
        if (entry.ledgerAccountId) {
          voucherLedgerMap.get(entry.voucherId)!.add(entry.ledgerAccountId);
        }
      }

      // Filter to vouchers that need backfill (missing entries or have wrong structure)
      const vouchersNeedingBackfill = allVouchers.filter((v) => {
        const ledgerIds = voucherLedgerMap.get(v.id) || new Set();
        const entryCount = ledgerIds.size;

        // Need backfill if:
        // 1. No entries at all
        // 2. Missing sales revenue
        // 3. Has wrong number of entries (old format had COGS/Inventory)
        const hasSalesRev = ledgerIds.has(salesRevenueAccount!.id);
        return entryCount === 0 || !hasSalesRev || entryCount !== 2;
      });

      if (vouchersNeedingBackfill.length === 0) {
        return res.json({
          message: "All sales vouchers already have complete accounting entries",
          count: 0,
        });
      }

      let backfilledCount = 0;
      let skippedCount = 0;

      for (const voucher of vouchersNeedingBackfill) {
        // Use a transaction to ensure atomic updates
        await db.transaction(async (tx) => {
          // Get all sales items for this voucher
          const items = await tx.select().from(salesItems).where(eq(salesItems.voucherId, voucher.id)).execute();

          if (items.length === 0) {
            logger.warn(`No sales items found for voucher ${voucher.id}, skipping`);
            skippedCount++;
            return;
          }

          // Calculate total sales
          const totalSales = items.reduce((sum, item) => sum + parseFloat(item.totalSales || "0"), 0);

          if (totalSales === 0) {
            logger.warn(`Voucher ${voucher.id} has zero sales, skipping`);
            skippedCount++;
            return;
          }

          // Determine location for this voucher by checking first sales item
          const firstItem = items[0];
          const stockItem = await tx.select().from(stockItems).where(eq(stockItems.id, firstItem.stockItemId)).limit(1);

          if (stockItem.length === 0) {
            logger.warn(`Could not find stock item ${firstItem.stockItemId} for voucher ${voucher.id}, skipping`);
            skippedCount++;
            return;
          }

          // Find inventory record to determine location
          const inventoryRecords = await tx
            .select()
            .from(inventory)
            .where(eq(inventory.stockItemId, stockItem[0].id))
            .limit(1);

          if (inventoryRecords.length === 0) {
            logger.warn(`Could not determine location for voucher ${voucher.id}, skipping`);
            skippedCount++;
            return;
          }

          const locationId = inventoryRecords[0].locationId;
          const cashAccountId = locationCashAccountMap[locationId];

          if (!cashAccountId) {
            logger.warn(`No cash account mapped for location ${locationId}, skipping voucher ${voucher.id}`);
            skippedCount++;
            return;
          }

          // Delete all existing voucher entries (in case of old format)
          await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));

          // Create new balanced entries (periodic inventory system)

          // Entry 1: Debit Cash Account (location-specific)
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: cashAccountId,
            debitAmount: totalSales.toFixed(2),
            creditAmount: "0",
            narration: `Cash from POS Sales - ${items.length} items (Backfilled)`,
          });

          // Entry 2: Credit Sales Revenue
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: salesRevenueAccount!.id,
            debitAmount: "0",
            creditAmount: totalSales.toFixed(2),
            narration: `Sales Revenue - ${items.length} items (Backfilled)`,
          });

          backfilledCount++;
        });
      }

      res.json({
        message: `Sales backfill completed. ${backfilledCount} vouchers updated, ${skippedCount} skipped.`,
        backfilledCount,
        skippedCount,
        totalSalesVouchers: allVouchers.length,
      });
    } catch (error: unknown) {
      logger.error("Sales backfill error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Price import from Excel: preview matching by stock item code
}
