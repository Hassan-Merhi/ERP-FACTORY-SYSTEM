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
import { and, eq, inArray } from "drizzle-orm";
import type {
  HandlerErrorResult,
  PosEditSaleItemInput,
  PosSaleUpdateResponseBody,
  SpEditAccountingContext,
  UpdatePosSaleParams,
  VoucherRow,
} from "./posEditSaleTypes";
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
import { postReversalResidualTx, saleCogsInventoryCreditTx } from "../../inventory/valueExactReversal";
import { rebuildSaleItems } from "./rebuildSaleItems";
import { nextCanonicalSourceRevision } from "../../inventory/canonicalSourceRevision";
import { updateVoucherRecord } from "./updateSaleVoucher";
import { rebuildSaleAccountingEntries } from "./rebuildSaleAccounting";
import {
  isGoldenCoastPosCompany,
  postGoldenCoastPosAccountingTx,
  retireGoldenCoastPosAccountingTx,
} from "../goldenCoastPosAccounting";
import { postSaleCogsTx } from "../../accounting/perpetualInventory/saleCogs";
import { baleMirrorMovementRefusal } from "../../accounting/perpetualInventory/cutoverRefusal";
import { spDeductionAmount, spPayableAfterDeduction } from "../spDeduction";

function err(result: HandlerErrorResult): { status: number; body: PosSaleUpdateResponseBody } {
  // HandlerErrorResult bodies are plain JSON message objects; the response
  // body type keeps arbitrary fields indexable for res.json().
  return { status: result.status, body: result.body as PosSaleUpdateResponseBody };
}

export interface PosSaleUpdateTransactionResult {
  error?: HandlerErrorResult;
  existingVoucher?: VoucherRow;
  targetLocationId?: number;
  grandTotal?: number;
  totalQtySoldEdit?: number;
  isGoldenCoastEdit?: boolean;
  auditOldItems?: Array<{
    stockItemId: number;
    quantity: string;
    rate: string;
    totalAmount: string;
  }>;
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
  const { isSpCompanyEdit, editSpPayableAccountId, editSpDeductionClrAccountId } = spContext;
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

  // Wave 11: a factory bale-mirror item is sold in the factory after the cut-over.
  const mirrorRefusal = await baleMirrorMovementRefusal(
    tx,
    currentCompanyId,
    items.map((item) => (item as { stockItemId?: unknown } | null)?.stockItemId),
    "pos-sale-edit"
  );
  if (mirrorRefusal) return { error: { status: mirrorRefusal.status, body: { ...mirrorRefusal.body } } };

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
  if (isGoldenCoastEdit && clientSaleId) {
    // Golden Coast settlement journals represent the CURRENT POS state. Retire
    // every active programme-generated settlement (including marker-less
    // recovery rows) before rebuilding the edited amount in this transaction.
    await retireGoldenCoastPosAccountingTx({
      tx,
      companyId: currentCompanyId,
      clientSaleId,
    });
  }

  const oldItemsMap = new Map(oldSalesItems.map((item) => [item.id, item]));
  // Wave 11: the old lines come back exactly; the ledger's COGS is compared below.
  const cogsBefore = await saleCogsInventoryCreditTx(tx, lockedVoucher.companyId, voucherId);
  const restoredDelta = await reverseOriginalSaleInventory(tx, lockedVoucher, oldSalesItems, canonicalRevision);
  await clearOldSaleRecords(tx, voucherId);

  const rebuildResult = await rebuildSaleItems(tx, {
    voucherId,
    targetLocationId,
    // Shape-checked by validateItemsPositive above; the symbol override can
    // only be present on trusted in-process payloads.
    items: items as PosEditSaleItemInput[],
    oldItemsMap,
    canSellNegativeStock,
    companyId: lockedVoucher.companyId,
    canonicalRevision,
  });

  await updateVoucherRecord(tx, {
    voucherId,
    description: typeof description === "string" ? description : null,
    grandTotal: rebuildResult.grandTotal,
    locationChanged,
    targetLocationId,
    oldLocationId,
    voucherDate: typeof voucherDate === "string" ? voucherDate : undefined,
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
      spPayableAfterDeduction(
        rebuildResult.grandTotal,
        spDeductionAmount(rebuildResult.totalQtySoldEdit, editSpDeductionPerQty)
      )
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

  // Perpetual inventory (wave 8.1): the edited sale's COGS replaces the old one.
  if (!isSpCompanyEdit) {
    await postSaleCogsTx(tx, {
      companyId: lockedVoucher.companyId,
      saleVoucherId: voucherId,
      saleVoucherNumber: lockedVoucher.voucherNumber,
      voucherDate: String(voucherDate || lockedVoucher.voucherDate),
      locationId: targetLocationId,
      relieved: rebuildResult.relieved,
      optional: lockedVoucher.optional === true,
    });
    // What the restore of the old lines moved beyond the COGS journal it
    // replaced (stock sold since, a legacy line) keeps the ledger with the
    // sub-ledger.
    await postReversalResidualTx(tx, {
      companyId: lockedVoucher.companyId,
      sourceType: "pos-edit",
      sourceId: `${voucherId}:${Date.now().toString(36)}`,
      reference: lockedVoucher.voucherNumber,
      subLedgerDelta: restoredDelta.minus(rebuildResult.relieved),
      ledgerDelta: cogsBefore.minus(await saleCogsInventoryCreditTx(tx, lockedVoucher.companyId, voucherId)),
      actor: { userId, username },
      locationId: targetLocationId,
    });
  }

  return {
    existingVoucher: lockedVoucher,
    targetLocationId,
    grandTotal: rebuildResult.grandTotal,
    totalQtySoldEdit: rebuildResult.totalQtySoldEdit,
    isGoldenCoastEdit,
    auditOldItems: oldSalesItems.map((item) => ({
      stockItemId: item.stockItemId,
      quantity: item.quantity,
      rate: item.sellingPrice,
      totalAmount: item.totalSales,
    })),
  };
}

export async function updatePosSale(
  params: UpdatePosSaleParams
): Promise<{ status: number; body: PosSaleUpdateResponseBody }> {
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
  // The request's voucherDate is untyped JSON; the string form is what the
  // recalculation set and the comparison below have always received.
  const newDate = voucherDate ? String(voucherDate) : oldDate;
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
    const oldAuditRows = transactionResult.auditOldItems ?? [];
    const oldItemIds = Array.from(new Set(oldAuditRows.map((item) => item.stockItemId)));
    const oldItemNames =
      oldItemIds.length > 0
        ? await db
            .select({ id: stockItems.id, name: stockItems.name, code: stockItems.code })
            .from(stockItems)
            .where(inArray(stockItems.id, oldItemIds))
        : [];
    const oldItemNameMap = new Map(oldItemNames.map((item) => [item.id, item] as const));

    const changes: Record<string, { old?: unknown; new?: unknown }> = {};
    if (existingVoucher.totalAmount !== updatedVoucher.totalAmount)
      changes.totalAmount = { old: existingVoucher.totalAmount, new: updatedVoucher.totalAmount };
    if (existingVoucher.voucherDate !== updatedVoucher.voucherDate)
      changes.date = { old: existingVoucher.voucherDate, new: updatedVoucher.voucherDate };
    if (existingVoucher.locationId !== updatedVoucher.locationId)
      changes.locationId = { old: existingVoucher.locationId, new: updatedVoucher.locationId };
    changes.itemCount = { new: updatedSalesItems.length };
    changes.items = {
      old: oldAuditRows.map((item) => ({
        stockItemId: item.stockItemId,
        stockItemName: oldItemNameMap.get(item.stockItemId)?.name ?? `Item #${item.stockItemId}`,
        code: oldItemNameMap.get(item.stockItemId)?.code ?? null,
        quantity: item.quantity,
        rate: item.rate,
        totalAmount: item.totalAmount,
      })),
      new: updatedSalesItems.map((item) => ({
        stockItemId: item.stockItemId,
        stockItemName: item.stockItemName,
        code: item.stockItemCode,
        quantity: item.quantity,
        rate: item.sellingPrice,
        totalAmount: item.totalSales,
      })),
    };
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
