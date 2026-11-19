import type { Express } from "express";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";

import { loadVoucherRelatedData } from "./voucherDetailBatching";

import { assertActiveCompanyAccess, sendCompanyAccessError } from "../../security/companyAccessBoundary";
import { toMoney } from "../../lib/money";
import { withPosZmwNativeTotals } from "../../services/pos/posVoucherNativeTotals";
import { getActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
import { posDaybookTransferText } from "@shared/posDaybookTransferText";
import {
  getPosDaybookLocations,
  getPosTransferScope,
  isStockTransferVoucherType,
  posTransferVisibleItems,
} from "../../services/pos/posDaybookTransferAccess";
import { withPropertiesRentalTenantNames } from "../../services/rental/rentalVoucherTenantRead";
import { registerVoucherQueryRoutesPart1 } from "./registerVoucherQueryRoutesPart1";

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

export function registerVoucherQueryRoutes(app: Express) {
  registerVoucherQueryRoutesPart1(app);

  // Get a specific voucher with all entries and related data
  app.get("/api/vouchers/:id", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      const voucher = await storage.getVoucherById(id);
      if (!voucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      // Verify voucher belongs to current company
      if (voucher.companyId !== access.activeCompanyId) {
        return res.status(403).json({
          message: "Access denied: Voucher belongs to a different company",
        });
      }

      // A transfer is read-only to a POS cashier and visible only when the
      // actual source/destination stock legs include an assigned location.
      // Never return ledger entries, transfer valuations, or other sources'
      // item rows through the generic voucher detail endpoint.
      const liveContext = await getActiveCompanyPermissionContext(req);
      if (liveContext.role === "POS" && isStockTransferVoucherType(voucher.voucherType)) {
        const scope = await getPosTransferScope(liveContext, voucher.id);
        if (!scope) return res.status(404).json({ message: posDaybookTransferText.notFound });
        const { transferData } = await loadVoucherRelatedData(voucher);
        if (!transferData?.id) return res.status(404).json({ message: posDaybookTransferText.notFound });
        const visibleItems = posTransferVisibleItems(transferData.items, scope);
        return res.json({
          id: voucher.id,
          voucherNumber: voucher.voucherNumber,
          voucherType: voucher.voucherType,
          voucherDate: voucher.voucherDate,
          createdAt: voucher.createdAt,
          description: transferData.notes || voucher.description,
          optional: voucher.optional,
          locationId: scope.displayLocationId,
          locationName: scope.displayLocationName,
          totalAmount: "0",
          entries: [],
          transferData: {
            id: transferData.id,
            voucherId: voucher.id,
            sourceLocationId: scope.isDestination ? transferData.sourceLocationId : scope.displayLocationId,
            sourceLocationName: scope.isDestination
              ? transferData.sourceLocationName || "Multi-source"
              : scope.displayLocationName,
            destinationLocationId: transferData.destinationLocationId,
            destinationLocationName: transferData.destinationLocationName,
            inventoryApplied: "inventoryApplied" in transferData ? transferData.inventoryApplied : undefined,
            notes: transferData.notes,
            items: visibleItems.map((item) => ({
              id: item.id,
              stockItemId: item.stockItemId,
              stockItemCode: item.stockItemCode,
              stockItemName: item.stockItemName,
              stockItemUom: item.stockItemUom,
              sourceLocationId: item.sourceLocationId ?? scope.headerSourceLocationId,
              sourceLocationName: item.sourceLocationName,
              quantity: item.quantity,
            })),
          },
        });
      }
      if (liveContext.role === "POS") {
        if (voucher.voucherType !== "Sales") {
          return res.status(404).json({ message: "Voucher not found" });
        }
        const locations = await getPosDaybookLocations(liveContext);
        if (voucher.locationId == null || !locations.has(voucher.locationId)) {
          return res.status(404).json({ message: "Voucher not found" });
        }
      }

      const [displayVoucher] = await withPropertiesRentalTenantNames(access.activeCompanyId, [voucher]);
      const [entries, relatedData] = await Promise.all([
        storage.getVoucherEntriesByVoucher(id),
        loadVoucherRelatedData(voucher),
      ]);
      const { purchaseOrder, salesItems: salesItemsList, adjustmentData, transferData } = relatedData;

      // For credit sales, resolve customer name from the voucher entries.
      // Credit sale entries store the customer receivable account via ledgerAccountId
      // (not customerId). getVoucherEntriesByVoucher already joins ledgerAccounts and
      // returns accountName, so we just find the debit entry and use its accountName.
      let customerName: string | null = null;
      if (voucher.isCreditSale) {
        const debitEntry = entries.find((e) => toMoney(e.debitAmount).toNumber() > 0);
        if (debitEntry?.accountName && debitEntry.accountName !== "Unknown Account") {
          customerName = debitEntry.accountName;
        }
      }

      // Cashiers may inspect sales at any of their assigned locations, but
      // never receive general-ledger entries, costs, profits or other ERP data.
      if (liveContext.role === "POS") {
        const [nativeSale] = await withPosZmwNativeTotals([displayVoucher]);
        return res.json({
          id: voucher.id,
          voucherNumber: voucher.voucherNumber,
          voucherType: voucher.voucherType,
          voucherDate: voucher.voucherDate,
          createdAt: voucher.createdAt,
          description: voucher.description,
          optional: voucher.optional,
          locationId: voucher.locationId,
          locationName: voucher.locationName,
          totalAmount: voucher.totalAmount,
          currency: voucher.currency,
          exchangeRate: voucher.exchangeRate,
          isCreditSale: voucher.isCreditSale,
          nativeZmwTotal: nativeSale.nativeZmwTotal ?? null,
          customerName,
          entries: [],
          salesItems: (salesItemsList ?? []).map((item) => ({
            id: item.id,
            stockItemId: item.stockItemId,
            stockItemName: item.stockItemName,
            stockItemCode: item.stockItemCode,
            quantity: item.quantity,
            sellingPrice: item.sellingPrice,
          })),
        });
      }

      res.json({
        ...displayVoucher,
        entries,
        purchaseOrder,
        salesItems: salesItemsList,
        adjustmentData,
        transferData,
        customerName,
      });
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });

  // Update a voucher with entries (Admin, Owner, or Manager for today's vouchers)
}
