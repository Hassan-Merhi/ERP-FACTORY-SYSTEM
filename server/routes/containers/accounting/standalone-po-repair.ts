import type { Express, NextFunction, Request, Response } from "express";
import { eq, inArray } from "drizzle-orm";

import { purchaseOrders, voucherEntries, vouchers } from "@shared/schema";
import { requireAuth } from "../../../auth";
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { storage } from "../../../storage";
import { calcPoAmounts } from "../containerHelpers";
import { sumMoney, toMoney } from "../../../lib/money";
import { syncPurchaseOrderGitTx } from "../../../services/accounting/perpetualInventory/stockReceipts";

interface StandaloneRepairSummary {
  handled: boolean;
  scannedPOs: number;
  repairedStandaloneSupplierVouchers: number;
  normalizedStandaloneParentFreight: number;
  skipped: string[];
  errors: string[];
}

async function isStandaloneErpCompany(companyId: number): Promise<boolean> {
  const [company, allCompanies, legacyParentCompanyId] = await Promise.all([
    storage.getCompanyById(companyId),
    storage.getAllCompanies(),
    storage.getParentCompanyId(),
  ]);

  if (!company) return false;
  if (company.parentCompanyId) return false;

  // The legacy global parent setting may identify the root company itself, but
  // it must never turn another unlinked company into a subsidiary.
  if (legacyParentCompanyId === companyId) return false;

  // A root company that is explicitly referenced by a child is also not a
  // standalone company, even if the old global parent setting is stale.
  if (allCompanies.some((candidate) => candidate.parentCompanyId === companyId)) return false;

  return true;
}

function normalizedUsdFields(debit: number, credit: number) {
  return {
    debitAmount: debit.toFixed(2),
    creditAmount: credit.toFixed(2),
    transactionCurrency: "USD",
    transactionDebitAmount: debit.toFixed(6),
    transactionCreditAmount: credit.toFixed(6),
    baseDebitAmount: debit.toFixed(6),
    baseCreditAmount: credit.toFixed(6),
    historicalExchangeRate: "1.0000000000",
    rateConvention: "IDENTITY",
  } as const;
}

/**
 * Repairs historical PO vouchers created while an unrelated global parent
 * setting incorrectly made a standalone ERP company behave like a subsidiary.
 *
 * This is deliberately explicit and idempotent. It does not touch inventory,
 * offload records, PO line items, container valuation, or any other company.
 * For a standalone company, a legacy `freightPaidBy=parent` value is invalid
 * because there is no linked parent, so it is normalized to supplier-paid.
 */
export async function repairStandalonePurchaseOrderAccounting(companyId: number): Promise<StandaloneRepairSummary> {
  const handled = await isStandaloneErpCompany(companyId);
  if (!handled) {
    return {
      handled: false,
      scannedPOs: 0,
      repairedStandaloneSupplierVouchers: 0,
      normalizedStandaloneParentFreight: 0,
      skipped: [],
      errors: [],
    };
  }

  // The Purchases account is resolved lazily, on the first PO that actually
  // needs repairing. Creating it up front made a no-op repair — a standalone
  // company with no purchase orders, or none needing repair — leave a new
  // ledger account behind, which is a real mutation for a call that reports
  // having changed nothing.
  let purchasesAccount: Awaited<ReturnType<typeof storage.getLedgerAccountByCode>> | null = null;
  const resolvePurchasesAccount = async () => {
    if (purchasesAccount) return purchasesAccount;
    purchasesAccount = await storage.getLedgerAccountByCode("PURCHASES", companyId);
    if (!purchasesAccount) {
      purchasesAccount = await storage.createLedgerAccount({
        companyId,
        code: "PURCHASES",
        name: "Purchases",
        accountType: "Expense",
        subType: "Direct Expense",
        openingBalance: "0",
        openingBalanceSide: "Dr",
        active: true,
      });
    }
    return purchasesAccount;
  };

  const purchaseOrdersForCompany = await storage.getAllPurchaseOrders(companyId);
  let repairedStandaloneSupplierVouchers = 0;
  let normalizedStandaloneParentFreight = 0;
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const po of purchaseOrdersForCompany) {
    try {
      if (!po.voucherId) {
        skipped.push(`PO ${po.poNumber}: no linked voucher; use PO backfill first`);
        continue;
      }
      if (!po.supplierId) {
        skipped.push(`PO ${po.poNumber}: no supplier selected`);
        continue;
      }
      if (po.freightPaidBy === "own") {
        // Own-account freight has a legitimate split payable structure and is
        // outside the historical global-parent defect this repair targets.
        skipped.push(`PO ${po.poNumber}: own-account freight left unchanged`);
        continue;
      }

      const { grossTotal } = calcPoAmounts({
        itemsTotal: po.itemsTotal,
        freight: po.freight,
        surcharge: po.surcharge,
        fumigation: po.fumigation,
        documentCharges: po.documentCharges,
        discount: po.discount,
        otherCharges: po.otherCharges,
        freightPaidBy: "supplier",
      });
      if (grossTotal <= 0) {
        skipped.push(`PO ${po.poNumber}: total is 0`);
        continue;
      }

      const [voucher] = await db
        .select({ id: vouchers.id, companyId: vouchers.companyId, totalAmount: vouchers.totalAmount })
        .from(vouchers)
        .where(eq(vouchers.id, po.voucherId))
        .limit(1);
      if (!voucher || voucher.companyId !== companyId) {
        skipped.push(`PO ${po.poNumber}: linked voucher is missing or belongs to another company`);
        continue;
      }

      const entries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, po.voucherId));
      const expected = grossTotal.toFixed(2);
      const debitEntries = entries.filter(
        (entry) => toMoney(entry.debitAmount).greaterThan(0) && toMoney(entry.creditAmount).isZero()
      );
      const creditEntries = entries.filter(
        (entry) => toMoney(entry.creditAmount).greaterThan(0) && toMoney(entry.debitAmount).isZero()
      );
      const debitSum = sumMoney(debitEntries.map((entry) => entry.debitAmount));
      const creditSum = sumMoney(creditEntries.map((entry) => entry.creditAmount));
      const supplierCreditSum = sumMoney(
        creditEntries.filter((entry) => entry.supplierId === po.supplierId).map((entry) => entry.creditAmount)
      );
      const hasForeignCreditTarget = creditEntries.some(
        (entry) => entry.supplierId !== po.supplierId || entry.ledgerAccountId !== null
      );
      const invalidParentFreight = po.freightPaidBy === "parent" || po.freightParentAccountId !== null;
      const voucherTotal = toMoney(voucher.totalAmount);
      const differs = (value: ReturnType<typeof toMoney>) => value.minus(grossTotal).abs().greaterThan(0.001);
      const needsRepair =
        invalidParentFreight ||
        differs(voucherTotal) ||
        differs(debitSum) ||
        differs(creditSum) ||
        differs(supplierCreditSum) ||
        hasForeignCreditTarget ||
        debitEntries.length !== 1 ||
        creditEntries.length !== 1;

      if (!needsRepair) continue;

      const purchasesLedgerAccount = await resolvePurchasesAccount();

      await db.transaction(async (tx) => {
        const debitEntry = debitEntries[0];
        const creditEntry = creditEntries[0];
        const retainedIds = new Set<number>();

        if (debitEntry) {
          retainedIds.add(debitEntry.id);
          await tx
            .update(voucherEntries)
            .set({
              ledgerAccountId: purchasesLedgerAccount!.id,
              supplierId: null,
              ...normalizedUsdFields(grossTotal, 0),
              narration: `PO ${po.poNumber} - Purchases (standalone repair)`,
            })
            .where(eq(voucherEntries.id, debitEntry.id));
        } else {
          const [createdDebit] = await tx
            .insert(voucherEntries)
            .values({
              voucherId: po.voucherId!,
              ledgerAccountId: purchasesLedgerAccount!.id,
              supplierId: null,
              ...normalizedUsdFields(grossTotal, 0),
              narration: `PO ${po.poNumber} - Purchases (standalone repair)`,
            })
            .returning({ id: voucherEntries.id });
          retainedIds.add(createdDebit.id);
        }

        if (creditEntry) {
          retainedIds.add(creditEntry.id);
          await tx
            .update(voucherEntries)
            .set({
              ledgerAccountId: null,
              supplierId: po.supplierId,
              ...normalizedUsdFields(0, grossTotal),
              narration: `PO ${po.poNumber} - Supplier (standalone repair)`,
            })
            .where(eq(voucherEntries.id, creditEntry.id));
        } else {
          const [createdCredit] = await tx
            .insert(voucherEntries)
            .values({
              voucherId: po.voucherId!,
              ledgerAccountId: null,
              supplierId: po.supplierId,
              ...normalizedUsdFields(0, grossTotal),
              narration: `PO ${po.poNumber} - Supplier (standalone repair)`,
            })
            .returning({ id: voucherEntries.id });
          retainedIds.add(createdCredit.id);
        }

        const extraEntryIds = entries.filter((entry) => !retainedIds.has(entry.id)).map((entry) => entry.id);
        if (extraEntryIds.length > 0) {
          await tx.delete(voucherEntries).where(inArray(voucherEntries.id, extraEntryIds));
        }

        await tx.update(vouchers).set({ totalAmount: expected }).where(eq(vouchers.id, po.voucherId!));

        if (invalidParentFreight) {
          await tx
            .update(purchaseOrders)
            .set({ freightPaidBy: "supplier", freightParentAccountId: null })
            .where(eq(purchaseOrders.id, po.id));
        }

        // Perpetual inventory (wave 8.2): goods in transit follows the repaired PO voucher.
        await syncPurchaseOrderGitTx(tx, po.companyId, po.id);
      });

      repairedStandaloneSupplierVouchers += 1;
      if (invalidParentFreight) normalizedStandaloneParentFreight += 1;
    } catch (error: unknown) {
      const message = `PO ${po.poNumber}: ${getErrorMessage(error)}`;
      errors.push(message);
      logger.error("[StandalonePORepair] Failed to repair PO", { poId: po.id, error });
    }
  }

  return {
    handled: true,
    scannedPOs: purchaseOrdersForCompany.length,
    repairedStandaloneSupplierVouchers,
    normalizedStandaloneParentFreight,
    skipped,
    errors,
  };
}

export async function standalonePoRepairBoundary(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "POST") return next();

  const companyId = req.session.currentCompanyId;
  if (!companyId) return next();

  const role = req.user?.role;
  if (!role || !["Admin", "Owner", "Developer"].includes(role)) return next();

  try {
    const repair = await repairStandalonePurchaseOrderAccounting(companyId);
    if (!repair.handled) return next();

    return res.json({
      scannedPOs: repair.scannedPOs,
      scannedContainers: 0,
      updatedLocalVouchers: repair.repairedStandaloneSupplierVouchers,
      updatedParentVouchers: 0,
      updatedFreightVouchers: 0,
      updatedContainerCharges: 0,
      updatedContainers: 0,
      repairedStandaloneSupplierVouchers: repair.repairedStandaloneSupplierVouchers,
      normalizedStandaloneParentFreight: repair.normalizedStandaloneParentFreight,
      skipped: repair.skipped,
      notFoundParentVouchers: [],
      missingParentFreightAccount: [],
      errors: repair.errors,
    });
  } catch (error: unknown) {
    logger.error("[StandalonePORepair] Fatal repair error", { error });
    return res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerStandalonePoRepairBoundary(app: Express) {
  // This mount is intentionally registered before the legacy sync-all route.
  // Standalone companies are handled here so that route cannot consult the
  // historical global parent and recreate the defect. Linked/root companies
  // fall through unchanged to the existing sync implementation.
  app.use("/api/containers/sync-all-vouchers", requireAuth, standalonePoRepairBoundary);
}
