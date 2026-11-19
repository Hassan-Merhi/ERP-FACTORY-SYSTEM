import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
/**
 * importRoutes: PoImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { voucherEntries } from "@shared/schema";
import {
  ParentCompanyPostingScopeError,
  runWithVerifiedParentCompanyScope,
} from "../../services/security/parentCompanyPostingScope";
import { nativePurchaseOrderFields } from "./poImportZambia";
import { FactoryTripPoReceiptError, completeFactoryTripPoReceipt } from "./factoryDispatchPoImportReceipt";

import { registerPoImportValidateRoute } from "./po-import-validate";
import { poImportStep, poImportChargePlan } from "./poImportStep";
import { poImportPoStep } from "./poImportPoStep";
import { poImportPoStep2 } from "./poImportPoStep2";

export function registerPoImportRoutes(app: Express) {
  registerPoImportValidateRoute(app);

  // PO Import - Import data
  app.post("/api/po-import/import", requireAuth, async (req, res) => {
    try {
      const s1 = await poImportStep({ req, res });
      if (s1.done) return s1.value;
      const {
        currentCompanyId,
        importDate,
        containerNumber,
        supplier,
        resolvedFreightPaidBy,
        isSubsidiary,
        parentCompanyId,
        container,
        supplierId,
        zambiaNative,
        resolvedFreightParentAccountId,
        factoryTripCheck,
        freshStockItems,
        charges,
        fileName,
        fileHash,
        containerPreview,
        factoryTripReceiptId,
      } = s1;
      const s2 = poImportChargePlan({ s1 });
      const { poEntries, nativeChargeSplits, hasAnyCharges } = s2;

      // Create POs and line items
      for (let poIndex = 0; poIndex < poEntries.length; poIndex++) {
        const p1 = poImportPoStep({ s2, poIndex, s1 });
        const {
          poNumber,
          poGrandTotal,
          poIntercoTotal,
          localEntries,
          createParentIntercompanyPosting,
          poItems,
          poItemsTotal,
          poFreight,
          poSurcharge,
          poFumigation,
          poDocumentCharges,
          poDiscount,
          poOtherCharges,
        } = p1;
        const p2 = await poImportPoStep2({ s1, res, p1 });
        if (p2.done) return p2.value;

        const voucher = await db.transaction(async (tx) => {
          const voucherFields = {
            companyId: currentCompanyId,
            currency: "USD",
            voucherNumber: `PO-${poNumber}-${Date.now()}`,
            voucherType: "Purchase",
            voucherDate: importDate,
            description: `${containerNumber} ${supplier?.legalName || "Unknown"}`,
            totalAmount: (resolvedFreightPaidBy === "parent" ? poGrandTotal : poIntercoTotal).toFixed(2),
            optional: false,
            sourceModule: "ERP",
          };
          const { voucher: localVoucher } = await insertInfrastructureVoucherTx(
            tx,
            voucherFields,
            infrastructurePostingIdentity("po-import", `${currentCompanyId}:${poNumber}`, "purchase"),
            voucherFields,
            { replaceEntriesOnReplay: false }
          );
          if (localEntries.length > 0) {
            await tx
              .insert(voucherEntries)
              .values(localEntries.map((entry) => ({ voucherId: localVoucher.id, ...entry })));
          }
          return localVoucher;
        });

        if (isSubsidiary && parentCompanyId) {
          // Every write in there lands in the parent company, which this request is not pinned
          // to, so it runs under the scope that re-verifies the parent link and the caller's
          // membership before the database scope moves.
          await runWithVerifiedParentCompanyScope(parentCompanyId, createParentIntercompanyPosting);
        }

        const po = await storage.createPurchaseOrder(
          {
            companyId: currentCompanyId,
            poNumber: poNumber,
            containerId: container.id,
            supplierId: supplierId,
            voucherId: voucher.id,
            currency: poItems[0]?.currency,
            ...nativePurchaseOrderFields(zambiaNative, nativeChargeSplits, poIndex, poItems.length, importDate),
            itemsTotal: poItemsTotal.toFixed(),
            freight: poFreight.toFixed(2),
            surcharge: poSurcharge.toFixed(2),
            fumigation: poFumigation.toFixed(2),
            documentCharges: poDocumentCharges.toFixed(2),
            discount: poDiscount.toFixed(2),
            otherCharges: poOtherCharges.toFixed(2),
            chargesEdited: hasAnyCharges,
            freightPaidBy: resolvedFreightPaidBy,
            freightParentAccountId: resolvedFreightPaidBy === "parent" ? resolvedFreightParentAccountId : null,
          },
          zambiaNative ? importDate : getClientDate(req)
        );

        for (const item of poItems) {
          // Re-lookup stock item by code/alias or name to get fresh ID (not stale preview data)
          let stockItemId = item.stockItemId;
          let stockItem = null;

          // Try code/alias first, then fall back to name
          if (item.barcode) {
            stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);
          }
          if (!stockItem && item.itemName && !factoryTripCheck.identity) {
            stockItem = freshStockItems.find((si) => si.name === item.itemName);
          }
          if (factoryTripCheck.identity && !stockItem) {
            throw new FactoryTripPoReceiptError(
              "FD_PO_ARTICLE_CHANGED",
              "ERP article alias changed during import. Purchase may have partially posted; reconcile the pending receipt instead of retrying."
            );
          }

          if (stockItem) {
            stockItemId = stockItem.id;
          }

          if (!stockItemId) {
            return res.status(400).json({
              message: `Stock item not found: ${item.barcode || item.itemName}. Please ensure all items exist before importing.`,
            });
          }

          await storage.createPOLineItem({
            poId: po.id,
            stockItemId: stockItemId,
            itemName: item.itemName,
            quantity: item.quantity.toString(),
            rate: item.rate.toString(),
            lineTotal: item.lineTotal.toString(),
            ...(zambiaNative ? { nativeRate: item.nativeRate, nativeLineTotal: item.nativeLineTotal } : {}),
          });
        }
      }

      // Create container charges records (for display in Container Extra Charges section)
      // Note: Charges are now consolidated into the main PO voucher, no separate vouchers needed
      const chargeTypesForContainer = [
        { type: "Freight", amount: charges.freight, isNegative: false },
        { type: "Surcharge", amount: charges.surcharge, isNegative: false },
        { type: "Fumigation", amount: charges.fumigation, isNegative: false },
        { type: "Discount", amount: charges.discount, isNegative: true },
        { type: "Document Charges", amount: charges.documentCharges, isNegative: false },
        { type: "Other Charges", amount: charges.otherCharges, isNegative: false },
      ];

      for (const charge of chargeTypesForContainer) {
        const chargeAmount = charge.amount ?? 0;
        if (chargeAmount > 0) {
          const actualAmount = charge.isNegative ? -chargeAmount : chargeAmount;

          // Create container charge record (for display only - charges are in PO voucher)
          await storage.createContainerCharge({
            containerId: container.id,
            chargeType: charge.type,
            amount: actualAmount.toString(),
          });
        }
      }

      // Create import log
      const importLog = await storage.createImportLog({
        fileName: fileName,
        fileHash: fileHash,
        rowCount: containerPreview.items.length,
        containerId: container.id,
        status: "Success",
      });
      if (factoryTripReceiptId !== null) {
        await completeFactoryTripPoReceipt(currentCompanyId, factoryTripReceiptId, container.id, importLog.id);
      }

      res.json({
        success: true,
        containerId: container.id,
        containerNumber: container.containerNumber,
        itemsCount: containerPreview.itemsCount,
        grandTotal: containerPreview.grandTotal,
        ...(factoryTripCheck.identity
          ? {
              factoryDispatchReceipt: {
                id: factoryTripReceiptId,
                origin: factoryTripCheck.identity,
                status: "IMPORTED",
                supplierId: supplierId,
                erpSupplierInvoiceTotal: factoryTripCheck.supplierTotal,
              },
            }
          : {}),
      });
    } catch (error: unknown) {
      logger.error("PO Import error:", { error: error });
      if (error instanceof FactoryTripPoReceiptError) {
        res.status(error.status).json({ code: error.code, message: error.message });
        return;
      }
      if (error instanceof ParentCompanyPostingScopeError) {
        res.status(error.status).json({ code: error.code, message: error.message });
        return;
      }
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
