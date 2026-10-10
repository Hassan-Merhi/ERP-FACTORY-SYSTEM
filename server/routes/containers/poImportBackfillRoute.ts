import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
import type { Express } from "express";
import { purchaseOrders, voucherEntries } from "@shared/schema";
import { eq } from "drizzle-orm";

import { requireAuth } from "../../auth";
import { db } from "../../db";
import { storage } from "../../storage";
import { logger } from "../../lib/logger";
import { getErrorMessage } from "../../lib/httpHandlers";

/**
 * POST /api/po-import/backfill — a one-off repair endpoint that creates the
 * missing purchase voucher, and its two entries, for every purchase order
 * imported before vouchers were written automatically.
 *
 * It has nothing to do with freight; it sat in containerFreightWriteRoutes only
 * because that is where the PO writes happened to live. Registered from the same
 * point in the same order, so config/route-manifest.json is unchanged.
 */
export function registerPoImportBackfillRoute(app: Express) {
  app.post("/api/po-import/backfill", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get all POs without voucher IDs
      const allPOs = await storage.getAllPurchaseOrders(req.session.currentCompanyId!);
      const posWithoutVouchers = allPOs.filter((po) => !po.voucherId);

      if (posWithoutVouchers.length === 0) {
        return res.json({
          message: "No POs need backfilling",
          count: 0,
        });
      }

      // Get or create "Purchases" ledger account for double-entry bookkeeping
      let purchasesAccount = await storage.getLedgerAccountByCode("PURCHASES", req.session.currentCompanyId!);
      if (!purchasesAccount) {
        purchasesAccount = await storage.createLedgerAccount({
          companyId: req.session.currentCompanyId!,
          code: "PURCHASES",
          name: "Purchases",
          accountType: "Expense",
          openingBalance: "0",
          openingBalanceSide: "Dr",
          active: true,
        });
      }

      // Get all containers to lookup import dates
      const allContainers = await storage.getAllContainers(req.session.currentCompanyId!);
      const containerMap = new Map(allContainers.map((c) => [c.id, c]));

      let backfilledCount = 0;

      for (const po of posWithoutVouchers) {
        const container = containerMap.get(po.containerId);
        if (!container) continue;
        const backfillSupplier = po.supplierId ? await storage.getSupplierById(po.supplierId) : null;

        // Create voucher for this PO with double-entry bookkeeping
        await db.transaction(async (tx) => {
          const voucherFields = {
            companyId: req.session.currentCompanyId!,
            currency: "USD",
            voucherNumber: `PO-${po.poNumber}-BACKFILL-${Date.now()}`,
            voucherType: "Purchase",
            voucherDate: container.importDate,
            description: `${container.containerNumber} ${backfillSupplier?.legalName || "Unknown Supplier"}`,
            totalAmount: po.itemsTotal || "0",
            optional: false,
            sourceModule: "ERP",
          };
          const { voucher: created } = await insertInfrastructureVoucherTx(
            tx,
            voucherFields,
            infrastructurePostingIdentity(
              "po-import-backfill",
              `${req.session.currentCompanyId!}:${po.id}`,
              "purchase"
            ),
            voucherFields,
            { replaceEntriesOnReplay: false }
          );

          // Debit: Purchases account (Expense increases)
          await tx.insert(voucherEntries).values({
            voucherId: created.id,
            ledgerAccountId: purchasesAccount.id,
            debitAmount: po.itemsTotal || "0",
            creditAmount: "0",
            narration: `PO ${po.poNumber} - Container ${container.containerNumber} (Backfilled)`,
          });

          // Credit: Supplier account (Accounts Payable increases)
          await tx.insert(voucherEntries).values({
            voucherId: created.id,
            supplierId: po.supplierId,
            debitAmount: "0",
            creditAmount: po.itemsTotal || "0",
            narration: `PO ${po.poNumber} - Container ${container.containerNumber} (Backfilled)`,
          });
          // The PO's voucher link commits with the voucher (wave 7).
          await tx.update(purchaseOrders).set({ voucherId: created.id }).where(eq(purchaseOrders.id, po.id));
        });

        backfilledCount++;
      }

      res.json({
        message: "Backfill completed successfully",
        count: backfilledCount,
      });
    } catch (error: unknown) {
      logger.error("Backfill error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
