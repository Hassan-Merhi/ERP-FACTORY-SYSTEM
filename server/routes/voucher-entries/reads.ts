/**
 * voucherEntryRoutes: VoucherEntryRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { calculateHassanPriceMetrics } from "./hassan-price";
import {
  stockItems,
  stockItemLocationPrices,
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  salesItems,
  purchaseOrders,
  locations,
  users,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { toMoney } from "../../lib/money";

export function registerVoucherEntryReadRoutes(app: Express) {
  app.get("/api/vouchers/:id/entries", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      // Verify voucher exists and belongs to current company
      const voucher = await storage.getVoucherById(id);
      if (!voucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      if (voucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Voucher belongs to a different company",
        });
      }

      // Use storage method to get entries with account names from joins
      const entries = await storage.getVoucherEntriesByVoucher(id);

      // Transform entries to include accountType for the Daybook editor
      const transformedEntries = entries.map((entry) => {
        let accountType: "ledger" | "bank" | "supplier" | "factorySupplier" | "employee" | "fixedAsset" | "customer" =
          "ledger";
        let accountId = entry.ledgerAccountId;

        if (entry.bankAccountId) {
          accountType = "bank";
          accountId = entry.bankAccountId;
        } else if (entry.supplierId) {
          accountType = "supplier";
          accountId = entry.supplierId;
        } else if (entry.factorySupplierId) {
          accountType = "factorySupplier";
          accountId = entry.factorySupplierId;
        } else if (entry.employeeId) {
          accountType = "employee";
          accountId = entry.employeeId;
        } else if (entry.fixedAssetId) {
          accountType = "fixedAsset";
          accountId = entry.fixedAssetId;
        } else if (entry.customerId) {
          accountType = "customer";
          accountId = entry.customerId;
        }

        return {
          ...entry,
          accountType,
          accountId: accountId || 0,
        };
      });

      res.json(transformedEntries);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get voucher entries with full details for viewing (includes account names and stock items)
  app.get("/api/vouchers/:id/view-entries", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      // Verify voucher exists and belongs to current company
      const voucher = await storage.getVoucherById(id);
      if (!voucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      if (voucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Voucher belongs to a different company",
        });
      }

      // Get regular voucher entries with account names
      const entries = await storage.getVoucherEntriesByVoucher(id);

      // For Sales vouchers, also get sales items
      if (voucher.voucherType === "Sales") {
        const userRole = req.session.currentRole;
        const isPOSUser = userRole === "POS";

        // Check ERP hidden field restrictions for non-POS users
        let hideSalesCostForErpUser = false;
        if (!isPOSUser) {
          const currentUserId = req.user?.id ? String(req.user.id) : null;
          if (currentUserId) {
            const [userProfile] = await db
              .select({ hiddenErpCostFields: users.hiddenErpCostFields })
              .from(users)
              .where(eq(users.id, currentUserId))
              .limit(1);
            const erpHidden: string[] = userProfile?.hiddenErpCostFields ?? [];
            hideSalesCostForErpUser = erpHidden.includes("sales_profit_cost");
          }
        }
        const hideCostAndProfit = isPOSUser || hideSalesCostForErpUser;

        const salesItemsList = await db
          .select({
            id: salesItems.id,
            voucherId: salesItems.voucherId,
            stockItemId: salesItems.stockItemId,
            quantity: salesItems.quantity,
            sellingPrice: salesItems.sellingPrice,
            costPrice: salesItems.costPrice,
            totalSales: salesItems.totalSales,
            profit: salesItems.profit,
            baseSellingPrice: stockItems.sellingPrice,
            stockItemName: stockItems.name,
            stockItemCode: stockItems.code,
          })
          .from(salesItems)
          .leftJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
          .where(eq(salesItems.voucherId, id));

        const locationPriceRows =
          voucher.locationId && salesItemsList.length > 0
            ? await db
                .select({
                  stockItemId: stockItemLocationPrices.stockItemId,
                  sellingPrice: stockItemLocationPrices.sellingPrice,
                })
                .from(stockItemLocationPrices)
                .where(
                  and(
                    eq(stockItemLocationPrices.locationId, voucher.locationId),
                    inArray(
                      stockItemLocationPrices.stockItemId,
                      salesItemsList.map((item) => item.stockItemId)
                    )
                  )
                )
            : [];
        const locationPriceMap = new Map(locationPriceRows.map((row) => [row.stockItemId, row.sellingPrice]));

        if (salesItemsList.length > 0) {
          const itemsWithDetails = salesItemsList.map((item) => {
            const priceListSellingPrice = locationPriceMap.get(item.stockItemId) ?? item.baseSellingPrice ?? null;
            const hassanMetrics = calculateHassanPriceMetrics(item.sellingPrice, priceListSellingPrice, item.quantity);

            return {
              id: item.id,
              voucherId: item.voucherId,
              stockItemId: item.stockItemId,
              stockItemName: item.stockItemName || "Unknown Item",
              stockItemCode: item.stockItemCode || "-",
              quantity: item.quantity,
              rate: item.sellingPrice,
              sellingPrice: item.sellingPrice,
              costPrice: hideCostAndProfit ? null : item.costPrice,
              totalSales: item.totalSales,
              profit: hideCostAndProfit ? null : item.profit,
              configuredPrice: hideCostAndProfit || !hassanMetrics ? null : hassanMetrics.price.toFixed(2),
              hassansPrice: hideCostAndProfit || !hassanMetrics ? null : hassanMetrics.price.toFixed(2),
              hassansProfit: hideCostAndProfit || !hassanMetrics ? null : hassanMetrics.profit.toFixed(2),
              hassansPercentage: hideCostAndProfit || !hassanMetrics ? null : hassanMetrics.percentage.toFixed(1),
              debitAmount: "0",
              creditAmount: item.totalSales,
              narration: `Sale of ${item.quantity} x ${item.stockItemName || "Unknown Item"} @ $${item.sellingPrice}`,
              accountName: item.stockItemName || "Unknown Item",
              accountCode: item.stockItemCode || "-",
              isStockItem: true,
            };
          });
          return res.json([...entries, ...itemsWithDetails]);
        }
      }

      // Check if user is a POS role (should not see cost prices)
      const userRole = req.session.currentRole;
      const isPOSUser = userRole === "POS";

      // For Purchase vouchers, get purchase order line items
      if (voucher.voucherType === "Purchase") {
        // Resolve only the purchase order linked to this voucher instead of loading
        // every purchase order for the company.
        const purchaseOrder = await db.query.purchaseOrders.findFirst({
          where: eq(purchaseOrders.voucherId, id),
        });

        if (purchaseOrder) {
          const lineItems = await storage.getLineItemsByPO(purchaseOrder.id);

          if (lineItems.length > 0) {
            // Supplier and container are independent references; resolve them together.
            const [supplier, container] = await Promise.all([
              storage.getSupplierById(purchaseOrder.supplierId),
              storage.getContainerById(purchaseOrder.containerId),
            ]);
            const supplierName = supplier?.legalName || "Unknown Supplier";
            const supplierCode = supplier?.code || "";
            const containerNumber = container?.containerNumber || "";

            const itemsWithDetails = lineItems.map((item: Record<string, unknown>) => ({
              id: item.id,
              voucherId: id,
              purchaseOrderId: purchaseOrder.id,
              stockItemId: item.stockItemId,
              stockItemName: item.stockItemName || item.itemName || "Unknown Item",
              stockItemCode: item.stockItemCode || "-",
              quantity: item.quantity,
              // SECURITY: Redact cost prices for POS users
              rate: isPOSUser ? null : item.rate,
              totalAmount: isPOSUser ? null : item.lineTotal || item.totalCost,
              debitAmount: isPOSUser ? "0" : item.lineTotal || item.totalCost,
              creditAmount: "0",
              narration: isPOSUser
                ? `${item.quantity} x ${item.stockItemName || item.itemName}`
                : `${item.quantity} x ${item.stockItemName || item.itemName} @ $${item.rate}`,
              accountName: item.stockItemName || item.itemName || "Unknown Item",
              accountCode: item.stockItemCode || "-",
              isStockItem: true,
              isPurchaseItem: true,
            }));

            // SECURITY: Also redact ledger entries for POS users
            const redactedEntries = isPOSUser
              ? entries.map((entry: Record<string, unknown>) => ({
                  ...entry,
                  debitAmount: "0",
                  creditAmount: "0",
                  narration: entry.accountName || "Account entry",
                }))
              : entries;

            // Add supplier entry and purchase order metadata
            const result = [...redactedEntries, ...itemsWithDetails];

            // Add purchase order metadata to response (hide totals for POS users)
            return res.json({
              entries: result,
              purchaseOrder: {
                id: purchaseOrder.id,
                poNumber: purchaseOrder.poNumber,
                supplierId: purchaseOrder.supplierId,
                supplierName: supplierName,
                supplierCode: supplierCode,
                containerId: purchaseOrder.containerId,
                containerNumber: containerNumber,
                currency: purchaseOrder.currency,
                itemsTotal: isPOSUser ? null : purchaseOrder.itemsTotal,
                status: purchaseOrder.status,
                // Include individual charges for display
                freight: isPOSUser ? null : purchaseOrder.freight,
                fumigation: isPOSUser ? null : purchaseOrder.fumigation,
                surcharge: isPOSUser ? null : purchaseOrder.surcharge,
                documentCharges: isPOSUser ? null : purchaseOrder.documentCharges,
                otherCharges: isPOSUser ? null : purchaseOrder.otherCharges,
                discount: isPOSUser ? null : purchaseOrder.discount,
              },
            });
          }
        }
      }

      // For Production/Consumption/Mixed vouchers, get stock adjustment items
      if (
        voucher.voucherType === "Production" ||
        voucher.voucherType === "Consumption" ||
        voucher.voucherType === "Mixed"
      ) {
        const adjustmentVoucher = await db.query.stockAdjustmentVouchers.findFirst({
          where: eq(stockAdjustmentVouchers.voucherId, id),
        });

        if (adjustmentVoucher) {
          const adjustmentItemsList = await db
            .select({
              id: stockAdjustmentItems.id,
              adjustmentId: stockAdjustmentItems.adjustmentId,
              stockItemId: stockAdjustmentItems.stockItemId,
              quantity: stockAdjustmentItems.quantity,
              rate: stockAdjustmentItems.rate,
              totalAmount: stockAdjustmentItems.totalAmount,
              stockItemName: stockItems.name,
              stockItemCode: stockItems.code,
            })
            .from(stockAdjustmentItems)
            .leftJoin(stockItems, eq(stockAdjustmentItems.stockItemId, stockItems.id))
            .where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));

          if (adjustmentItemsList.length > 0) {
            const itemsWithDetails = adjustmentItemsList.map((item) => {
              // For Mixed vouchers, determine Production vs Consumption by quantity sign
              // Positive quantity = Production (adding stock), Negative = Consumption (removing stock)
              const qty = toMoney(item.quantity).toNumber();
              const isProduction = voucher.voucherType === "Production" || (voucher.voucherType === "Mixed" && qty > 0);
              const adjustmentLabel =
                voucher.voucherType === "Mixed" ? (qty > 0 ? "Production" : "Consumption") : voucher.voucherType;

              return {
                id: item.id,
                voucherId: id,
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName || "Unknown Item",
                stockItemCode: item.stockItemCode || "-",
                quantity: item.quantity,
                rate: isPOSUser ? null : item.rate,
                debitAmount: isPOSUser ? "0" : isProduction ? item.totalAmount : "0",
                creditAmount: isPOSUser ? "0" : isProduction ? "0" : item.totalAmount,
                narration: isPOSUser
                  ? `${adjustmentLabel} of ${Math.abs(qty)} x ${item.stockItemName || "Unknown Item"}`
                  : `${adjustmentLabel} of ${Math.abs(qty)} x ${item.stockItemName || "Unknown Item"} @ $${item.rate}`,
                accountName: item.stockItemName || "Unknown Item",
                accountCode: item.stockItemCode || "-",
                isStockItem: true,
                totalAmount: isPOSUser ? null : item.totalAmount,
                adjustmentType: adjustmentLabel,
              };
            });
            return res.json(itemsWithDetails);
          }
        }
      }

      // For Stock Transfer vouchers, get stock transfer items
      if (
        voucher.voucherType === "Stock Transfer" ||
        voucher.voucherType === "StockTransfer" ||
        voucher.voucherType === "Transfer"
      ) {
        const transferVoucher = await db.query.stockTransferVouchers.findFirst({
          where: eq(stockTransferVouchers.voucherId, id),
        });

        if (transferVoucher) {
          const transferItemsList = await db
            .select({
              id: stockTransferItems.id,
              transferId: stockTransferItems.transferId,
              stockItemId: stockTransferItems.stockItemId,
              sourceLocationId: stockTransferItems.sourceLocationId,
              quantity: stockTransferItems.quantity,
              rate: stockTransferItems.rate,
              totalAmount: stockTransferItems.totalAmount,
              stockItemName: stockItems.name,
              stockItemCode: stockItems.code,
            })
            .from(stockTransferItems)
            .leftJoin(stockItems, eq(stockTransferItems.stockItemId, stockItems.id))
            .where(eq(stockTransferItems.transferId, transferVoucher.id));

          if (transferItemsList.length > 0) {
            // Collect all location IDs we need to resolve
            const locationIdSet = new Set<number>();
            if (transferVoucher.sourceLocationId) locationIdSet.add(transferVoucher.sourceLocationId);
            for (const item of transferItemsList) {
              if (item.sourceLocationId) locationIdSet.add(item.sourceLocationId);
            }
            const locationIds = Array.from(locationIdSet);
            const locationRows =
              locationIds.length > 0
                ? await db
                    .select({ id: locations.id, name: locations.name })
                    .from(locations)
                    .where(inArray(locations.id, locationIds))
                : [];
            const locationMap = new Map(locationRows.map((l) => [l.id, l.name]));
            const transferSourceName = transferVoucher.sourceLocationId
              ? (locationMap.get(transferVoucher.sourceLocationId) ?? "")
              : "";

            const itemsWithDetails = transferItemsList.map((item) => {
              const itemSourceName = item.sourceLocationId
                ? (locationMap.get(item.sourceLocationId) ?? transferSourceName)
                : transferSourceName;
              return {
                id: item.id,
                voucherId: id,
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName || "Unknown Item",
                stockItemCode: item.stockItemCode || "-",
                quantity: item.quantity,
                rate: isPOSUser ? null : item.rate,
                debitAmount: "0",
                creditAmount: isPOSUser ? "0" : item.totalAmount,
                narration: isPOSUser
                  ? `Transfer of ${item.quantity} x ${item.stockItemName || "Unknown Item"}`
                  : `Transfer of ${item.quantity} x ${item.stockItemName || "Unknown Item"} @ ${item.rate}`,
                accountName: item.stockItemName || "Unknown Item",
                accountCode: item.stockItemCode || "-",
                isStockItem: true,
                totalAmount: isPOSUser ? null : item.totalAmount,
                sourceLocationName: itemSourceName,
              };
            });
            return res.json(itemsWithDetails);
          }
          // stockTransferVouchers record exists but no items — return empty array
          // (do NOT fall through to generic financial entries which show as 0-qty rows)
          return res.json([]);
        }
        // No stockTransferVouchers record found for this voucher — return empty array
        return res.json([]);
      }

      // SECURITY: Final fallback redaction for POS users - ensure no cost data leaks
      if (isPOSUser) {
        const redactedFallbackEntries = entries.map((entry: Record<string, unknown>) => ({
          ...entry,
          debitAmount: "0",
          creditAmount: "0",
          narration: entry.accountName || "Account entry",
        }));
        return res.json(redactedFallbackEntries);
      }

      res.json(entries);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
