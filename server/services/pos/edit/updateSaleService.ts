/**
 * server/services/pos/edit/updateSaleService.ts
 *
 * PHASE 20 — POS Backend Edit-Sale Structural Split.
 *
 * Program 2C keeps the existing edit formulas and response contract, while
 * moving the authoritative voucher, location, currency, accounting-entry, and
 * sales-item reads under one transaction lock. Concurrent edits therefore use
 * the latest committed sale state instead of stale pre-transaction snapshots.
 */
import { db, type DbTransaction } from "../../../db";
import { logger } from "../../../lib/logger";
import { storage } from "../../../storage";
import { logAudit, recalculateIntercompanyForDate } from "../../../routes/_helpers";
import { salesItems, voucherEntries, stockItems, vouchers } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import type { HandlerErrorResult, SpEditAccountingContext, UpdatePosSaleParams } from "./posEditSaleTypes";
import { fetchSpEditAccountingContext, fetchSpEditDeductionPerQty } from "./posEditSaleHelpers";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import {
  validateItemsPositive,
  loadAndValidateExistingVoucher,
  applyPosRoleRestrictions,
  resolveEditLocations,
  validateNewLocationBelongsToCompany,
} from "./validateEditSaleRequest";
import { reverseOriginalSaleInventory, clearOldSaleRecords } from "./reverseOriginalSaleInventory";
import { rebuildSaleItems } from "./rebuildSaleItems";
import { nextCanonicalSourceRevision } from "../../inventory/canonicalSourceRevision";
import { updateVoucherRecord } from "./updateSaleVoucher";
import { rebuildSaleAccountingEntries } from "./rebuildSaleAccounting";
import {
  isGoldenCoastPosCompany,
  postGoldenCoastPosAccountingTx,
  reverseGoldenCoastPosAccountingTx,
} from "../goldenCoastPosAccounting";

function err(result: HandlerErrorResult) {
  return { status: result.status, body: result.body };
}

export interface PosSaleUpdateTransactionResult {
  error?: HandlerErrorResult;
  existingVoucher?: any;
  targetLocationId?: number;
  grandTotal?: number;
  totalQtySoldEdit?: number;
  isGoldenCoastEdit?: boolean;
}

/**
 * Apply one POS sale edit using a caller-owned transaction.
 *
 * The public updatePosSale() wrapper still opens its own transaction for normal
 * single-sale edits. Bulk correction tools can call this core repeatedly inside
 * one outer transaction so either every voucher edit commits or none do.
 */
export async function applyPosSaleUpdateTx(
  tx: DbTransaction,
  params: UpdatePosSaleParams,
  spContext: SpEditAccountingContext
): Promise<PosSaleUpdateTransactionResult> {
  const { voucherId, currentCompanyId, userId, username, userRole, canSellNegativeStock, body } = params;
  const {
    isSpCompanyEdit,
    editSpPayableAccountId,
    editSpDeductionClrAccountId,
  } = spContext;
  const {
    description,
    items,
    paymentAccountType: rawPaymentAccountType,
    paymentAccountId: rawPaymentAccountId,
    isCreditSale,
    voucherDate,
    locationId: newLocationId,
  } = body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return { error: { status: 400, body: { message: "At least one item is required" } } };
  }
  validateItemsPositive(items);

  const [lockedVoucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, currentCompanyId)))
    .for("update");

  if (!lockedVoucher || lockedVoucher.deletedAt) {
    return { error: { status: 404, body: { message: "Voucher not found" } } };
  }
  if (lockedVoucher.voucherType !== "Sales") {
    return {
      error: {
        status: 400,
        body: { message: "Only Sales vouchers can be updated with this endpoint" },
      },
    };
  }
  const blockedVoucherReason = voucherMutationBlockReason(lockedVoucher);
  if (blockedVoucherReason) {
    return { error: { status: 403, body: { message: blockedVoucherReason } } };
  }

  const restrictionResult = applyPosRoleRestrictions(userRole, newLocationId, lockedVoucher.locationId);
  if ("error" in restrictionResult) return restrictionResult;

  if (!lockedVoucher.locationId) {
    return { error: { status: 400, body: { message: "Existing sale is missing a location" } } };
  }

  const { targetLocationId, oldLocationId, locationChanged } = resolveEditLocations(
    lockedVoucher.locationId,
    newLocationId
  );

  if (locationChanged) {
    const newLocationResult = await validateNewLocationBelongsToCompany(
      targetLocationId,
      oldLocationId,
      currentCompanyId,
      tx
    );
    if ("error" in newLocationResult) return newLocationResult;
  }

  const editSpDeductionPerQty = await fetchSpEditDeductionPerQty(isSpCompanyEdit, targetLocationId, tx);
  const oldEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
  const oldSalesItems = await tx.select().from(salesItems).where(eq(salesItems.voucherId, voucherId)).for("update");
  oldSalesItems.sort((a, b) => a.stockItemId - b.stockItemId);

  const canonicalRevision = await nextCanonicalSourceRevision(
    tx,
    lockedVoucher.companyId,
    "pos-sale",
    String(voucherId)
  );

  const isGoldenCoastEdit = isSpCompanyEdit && (await isGoldenCoastPosCompany(tx, currentCompanyId));
  const clientSaleId = String(lockedVoucher.clientSaleId ?? "").trim();
  if (isGoldenCoastEdit && clientSaleId && !lockedVoucher.isCreditSale) {
    await reverseGoldenCoastPosAccountingTx({
      tx,
      companyId: currentCompanyId,
      clientSaleId,
      revision: canonicalRevision,
      actor: { userId, username, reason: `Edit Golden Coast POS sale ${lockedVoucher.voucherNumber}` },
    });
  }

  const oldItemsMap = new Map(oldSalesItems.map((item) => [item.id, item]));
  await reverseOriginalSaleInventory(tx, lockedVoucher, oldSalesItems, canonicalRevision);
  await clearOldSaleRecords(tx, voucherId);

  const rebuildResult = await rebuildSaleItems(tx, {
    voucherId,
    targetLocationId,
    items,
    oldItemsMap,
    canSellNegativeStock,
    companyId: lockedVoucher.companyId,
    canonicalRevision,
  });

  await updateVoucherRecord(tx, {
    voucherId,
    description,
    grandTotal: rebuildResult.grandTotal,
    locationChanged,
    targetLocationId,
    oldLocationId,
    voucherDate,
    isCreditSale: Boolean(isCreditSale),
  });

  await rebuildSaleAccountingEntries(tx, {
    voucherId,
    oldEntries,
    grandTotal: rebuildResult.grandTotal,
    paymentAccountType: rawPaymentAccountType,
    paymentAccountId: rawPaymentAccountId,
    isSpCompanyEdit,
    editSpPayableAccountId,
    editSpDeductionClrAccountId,
    totalQtySoldEdit: rebuildResult.totalQtySoldEdit,
    editSpDeductionPerQty,
    currency: lockedVoucher.currency || "USD",
    exchangeRate: lockedVoucher.exchangeRate ? String(lockedVoucher.exchangeRate) : null,
  });

  if (isGoldenCoastEdit && clientSaleId && !isCreditSale) {
    const oldPaymentEntry = oldEntries.find((entry) => Number(entry.debitAmount ?? 0) > 0);
    const normalizedPaymentType =
      rawPaymentAccountType === "bank" || rawPaymentAccountType === "cash"
        ? rawPaymentAccountType
        : oldPaymentEntry?.bankAccountId
          ? "bank"
          : "cash";
    const normalizedPaymentId = Number(
      rawPaymentAccountId || oldPaymentEntry?.bankAccountId || oldPaymentEntry?.ledgerAccountId || 0
    );
    if (!Number.isInteger(normalizedPaymentId) || normalizedPaymentId <= 0) {
      throw new Error("Golden Coast POS edit requires a valid cash or bank payment account");
    }
    const payableAmount = Math.max(
      0,
      Number((rebuildResult.grandTotal - rebuildResult.totalQtySoldEdit * editSpDeductionPerQty).toFixed(2))
    );
    await postGoldenCoastPosAccountingTx({
      tx,
      companyId: currentCompanyId,
      locationId: targetLocationId,
      clientSaleId,
      revision: `edit${canonicalRevision}`,
      saleDate: String(voucherDate || lockedVoucher.voucherDate),
      amountUsd: rebuildResult.grandTotal,
      paymentAccountType: normalizedPaymentType,
      paymentAccountId: normalizedPaymentId,
      supplierPayableAccountId: editSpPayableAccountId!,
      payableAmountUsd: payableAmount,
      actor: { userId, username, reason: `Edit Golden Coast itemized POS sale ${lockedVoucher.voucherNumber}` },
    });
  }

  return {
    existingVoucher: lockedVoucher,
    targetLocationId,
    grandTotal: rebuildResult.grandTotal,
    totalQtySoldEdit: rebuildResult.totalQtySoldEdit,
    isGoldenCoastEdit,
  };
}

export async function updatePosSale(params: UpdatePosSaleParams): Promise<{ status: number; body: any }> {
  const { voucherId, currentCompanyId, userId, username, userRole, body } = params;

  const spContextResult = await fetchSpEditAccountingContext(currentCompanyId);
  if ("error" in spContextResult) return err(spContextResult.error);

  const { items, isCreditSale, voucherDate, locationId: newLocationId } = body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return { status: 400, body: { message: "At least one item is required" } };
  }
  validateItemsPositive(items);

  // Fast validation before opening the transaction. The same state-sensitive
  // checks are repeated against the locked voucher in applyPosSaleUpdateTx().
  const voucherResult = await loadAndValidateExistingVoucher(voucherId, currentCompanyId);
  if ("error" in voucherResult) return err(voucherResult.error);
  const preExistingVoucher = voucherResult.existingVoucher;

  const blockedVoucherReason = voucherMutationBlockReason(preExistingVoucher);
  if (blockedVoucherReason) {
    return err({ status: 403, body: { message: blockedVoucherReason } });
  }

  const preRestrictionResult = applyPosRoleRestrictions(userRole, newLocationId, preExistingVoucher.locationId);
  if ("error" in preRestrictionResult) return err(preRestrictionResult.error);

  const transactionResult = await db.transaction((tx) => applyPosSaleUpdateTx(tx, params, spContextResult.context));
  if (transactionResult.error) return err(transactionResult.error);

  const existingVoucher = transactionResult.existingVoucher!;
  const targetLocationId = transactionResult.targetLocationId!;

  const [updatedVoucher] = await db.select().from(vouchers).where(eq(vouchers.id, voucherId)).limit(1);
  const updatedSalesItems = await db
    .select({
      id: salesItems.id,
      stockItemId: salesItems.stockItemId,
      stockItemName: stockItems.name,
      stockItemCode: stockItems.code,
      quantity: salesItems.quantity,
      sellingPrice: salesItems.sellingPrice,
      costPrice: salesItems.costPrice,
      totalSales: salesItems.totalSales,
      totalCost: salesItems.totalCost,
      profit: salesItems.profit,
      rate: salesItems.sellingPrice,
      rateUSD: salesItems.sellingPrice,
    })
    .from(salesItems)
    .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
    .where(eq(salesItems.voucherId, voucherId));

  const updatedLocation = await storage.getLocationById(targetLocationId);

  let customerAccount = null;
  if (isCreditSale) {
    const updatedEntries = await db.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
    const debitEntry = updatedEntries.find((entry) => parseFloat(entry.debitAmount || "0") > 0);
    if (debitEntry?.ledgerAccountId) {
      customerAccount = await storage.getLedgerAccountById(debitEntry.ledgerAccountId);
    }
  }

  const oldDate = existingVoucher.voucherDate;
  const newDate = voucherDate || oldDate;
  const datesToRecalc = new Set<string>([oldDate]);
  if (newDate !== oldDate) datesToRecalc.add(newDate);
  if (!transactionResult.isGoldenCoastEdit) {
    for (const date of datesToRecalc) {
      recalculateIntercompanyForDate(currentCompanyId, date).catch((error) =>
        logger.error("[IntercompanyPOS Recalc] Unhandled:", { error })
      );
    }
  }

  try {
    const changes: Record<string, { old?: any; new?: any }> = {};
    if (existingVoucher.totalAmount !== updatedVoucher.totalAmount)
      changes.totalAmount = { old: existingVoucher.totalAmount, new: updatedVoucher.totalAmount };
    if (existingVoucher.voucherDate !== updatedVoucher.voucherDate)
      changes.date = { old: existingVoucher.voucherDate, new: updatedVoucher.voucherDate };
    if (existingVoucher.locationId !== updatedVoucher.locationId)
      changes.locationId = { old: existingVoucher.locationId, new: updatedVoucher.locationId };
    changes.itemCount = { new: updatedSalesItems.length };
    await logAudit({
      userId,
      username,
      companyId: currentCompanyId,
      action: "update",
      tableName: "vouchers",
      recordId: voucherId,
      recordIdentifier: updatedVoucher.voucherNumber,
      changes,
    });
  } catch {
    /* non-fatal */
  }

  return {
    status: 200,
    body: {
      voucher: updatedVoucher,
      location: updatedLocation,
      items: updatedSalesItems,
      grandTotal: updatedVoucher.totalAmount,
      voucherNumber: updatedVoucher.voucherNumber,
      saleDate: updatedVoucher.voucherDate,
      isCreditSale: !!isCreditSale,
      customer: customerAccount
        ? { id: customerAccount.id, code: customerAccount.code, name: customerAccount.name }
        : null,
    },
  };
}
