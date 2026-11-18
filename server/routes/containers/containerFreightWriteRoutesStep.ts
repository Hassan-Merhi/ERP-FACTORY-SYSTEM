// Extracted from ./containerFreightWriteRoutes.ts: a stage of containerFreightWriteRoutes.
import { parseId } from "../../lib/parseId";
import { db } from "../../db";
import { storage } from "../../storage";
import { ledgerAccounts } from "@shared/schema";
import type { InsertPurchaseOrder } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { calcPoAmountsExact, differsByMoreThanTolerance as differs } from "./containerHelpers";
import { toMoney } from "../../lib/money";
import { applyPurchaseOrderItemsUpdate } from "./purchaseOrderItemsUpdate";
import { assertZmwPurchaseEditAllowed, convertNativeChargeEdits } from "./purchaseOrderZmwEdit";
import { storedCents } from "./containerChargeSync";
import type { Request, Response } from "express";

export async function containerFreightWriteRoutesStep({ req, res }: { req: Request; res: Response }) {
  const id = parseId(req.params.id);
  if (id === null) return { done: true as const, value: res.status(400).json({ message: "Invalid id" }) };
  if (isNaN(id)) {
    return { done: true as const, value: res.status(400).json({ message: "Invalid purchase order ID" }) };
  }

  const existingPO = await storage.getPurchaseOrderByIdForCompany(id, req.session.currentCompanyId!);
  if (!existingPO) {
    return { done: true as const, value: res.status(404).json({ message: "Purchase order not found" }) };
  }

  // Verify purchase order belongs to current company
  if (existingPO.companyId !== req.session.currentCompanyId) {
    return {
      done: true as const,
      value: res.status(403).json({
        message: "Access denied: Purchase order belongs to a different company",
      }),
    };
  }

  // A posted Kwacha PO keeps its currency and locked rate (409 otherwise).
  const nativeZmw = assertZmwPurchaseEditAllowed(existingPO, req.body);

  // Check edit permissions based on role
  const userRole = req.session.currentRole;
  if (!userRole) {
    return { done: true as const, value: res.status(403).json({ message: "User role not found" }) };
  }

  // Only Admin and Owner can edit purchase orders
  if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
    return {
      done: true as const,
      value: res.status(403).json({ message: "Only Admin and Owner can edit purchase orders" }),
    };
  }

  // Check if container is offloaded - if so, prevent stock item changes that would cause import cycle imbalance
  const container = await storage.getContainerByIdForCompany(existingPO.containerId, req.session.currentCompanyId!);
  if (container?.status === "OFFLOADED" && req.body.items && Array.isArray(req.body.items)) {
    const existingLineItems = await storage.getLineItemsByPO(id);
    const existingStockItemIds = new Set(existingLineItems.map((item) => item.stockItemId));

    // Check if any stock item is being changed (swapped)
    // Normalize stockItemId to number to avoid type mismatch if client sends strings
    for (const item of req.body.items) {
      const stockItemId = item.stockItemId ? Number(item.stockItemId) : null;
      if (stockItemId && !existingStockItemIds.has(stockItemId)) {
        return {
          done: true as const,
          value: res.status(400).json({
            message:
              "Cannot change stock items on an offloaded container. The inventory has already been added with the original items. Changing stock items would cause an import cycle imbalance. To fix this, first reverse the container offload, then edit the PO, then re-offload.",
          }),
        };
      }
    }
  }

  // Update line items if provided. The items path reprices the whole PO and
  // is a complete response on its own; it lives in ./purchaseOrderItemsUpdate.
  if (req.body.items && Array.isArray(req.body.items)) {
    return { done: true as const, value: res.json(await applyPurchaseOrderItemsUpdate(req, { id, existingPO })) };
  }

  // Charge-only Kwacha edits: keep the native amounts and rewrite the
  // request's charges to historical USD at the locked rate before the
  // existing voucher, parent and inventory synchronizers run.
  const nativeChargeChanges: Partial<InsertPurchaseOrder> = nativeZmw
    ? convertNativeChargeEdits(existingPO, req.body)
    : {};

  // Only allow updating specific fields if no items provided
  const allowedUpdates: Partial<InsertPurchaseOrder> = { ...nativeChargeChanges };
  if (req.body.poNumber !== undefined) allowedUpdates.poNumber = req.body.poNumber;
  if (req.body.itemsTotal !== undefined) allowedUpdates.itemsTotal = req.body.itemsTotal;
  if (req.body.currency !== undefined) allowedUpdates.currency = req.body.currency;
  if (req.body.status !== undefined) allowedUpdates.status = req.body.status;
  if (req.body.freight !== undefined) allowedUpdates.freight = req.body.freight;
  if (req.body.surcharge !== undefined) allowedUpdates.surcharge = req.body.surcharge;
  if (req.body.fumigation !== undefined) allowedUpdates.fumigation = req.body.fumigation;
  if (req.body.documentCharges !== undefined) allowedUpdates.documentCharges = req.body.documentCharges;
  if (req.body.discount !== undefined) allowedUpdates.discount = req.body.discount;
  if (req.body.otherCharges !== undefined) allowedUpdates.otherCharges = req.body.otherCharges;
  if (req.body.freightPaidBy !== undefined) allowedUpdates.freightPaidBy = req.body.freightPaidBy;
  if (req.body.freightOwnAccountId !== undefined)
    allowedUpdates.freightOwnAccountId =
      req.body.freightOwnAccountId === null
        ? null
        : req.body.freightOwnAccountId
          ? Number(req.body.freightOwnAccountId)
          : null;
  if (req.body.freightParentAccountId !== undefined)
    allowedUpdates.freightParentAccountId =
      req.body.freightParentAccountId === null
        ? null
        : req.body.freightParentAccountId
          ? Number(req.body.freightParentAccountId)
          : null;

  // Account references are company-owned. Validate them before changing the
  // PO so a foreign ID cannot be persisted or reach voucher accounting.
  const requestedLedgerAccountIds = [allowedUpdates.freightOwnAccountId, allowedUpdates.freightParentAccountId].filter(
    (accountId): accountId is number => typeof accountId === "number"
  );
  if (requestedLedgerAccountIds.length > 0) {
    const scopedAccounts = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(eq(ledgerAccounts.companyId, existingPO.companyId), inArray(ledgerAccounts.id, requestedLedgerAccountIds))
      );
    const scopedAccountIds = new Set(scopedAccounts.map((account) => account.id));
    if (requestedLedgerAccountIds.some((accountId) => !scopedAccountIds.has(accountId))) {
      return {
        done: true as const,
        value: res.status(400).json({
          message: "Freight ledger account must belong to the purchase order company",
        }),
      };
    }
  }

  // Set chargesEdited flag if any charge field was modified
  const chargesWereEdited =
    req.body.freight !== undefined ||
    req.body.surcharge !== undefined ||
    req.body.fumigation !== undefined ||
    req.body.documentCharges !== undefined ||
    req.body.discount !== undefined ||
    req.body.otherCharges !== undefined;
  if (chargesWereEdited) {
    allowedUpdates.chargesEdited = true;
  }

  // Check if any charges changed - need to update voucher entries
  const newFreight = storedCents(req.body.freight ?? existingPO.freight);
  const newSurcharge = storedCents(req.body.surcharge ?? existingPO.surcharge);
  const newFumigation = storedCents(req.body.fumigation ?? existingPO.fumigation);
  const newDocumentCharges = storedCents(req.body.documentCharges ?? existingPO.documentCharges);
  const newDiscount = storedCents(req.body.discount ?? existingPO.discount);
  const newOtherCharges = storedCents(req.body.otherCharges ?? existingPO.otherCharges);
  const newItemsTotal = storedCents(req.body.itemsTotal ?? existingPO.itemsTotal);
  const oldFreight = toMoney(existingPO.freight);
  const oldSurcharge = toMoney(existingPO.surcharge);
  const oldFumigation = toMoney(existingPO.fumigation);
  const oldDocumentCharges = toMoney(existingPO.documentCharges);
  const oldDiscount = toMoney(existingPO.discount);
  const oldOtherCharges = toMoney(existingPO.otherCharges);
  const oldItemsTotal = toMoney(existingPO.itemsTotal);

  const poChargeRows = [
    { chargeType: "Freight", amount: newFreight },
    { chargeType: "Surcharge", amount: newSurcharge },
    { chargeType: "Fumigation", amount: newFumigation },
    { chargeType: "Document Charges", amount: newDocumentCharges },
    { chargeType: "Discount", amount: newDiscount.negated() }, // Discount stored as negative
    { chargeType: "Other Charges", amount: newOtherCharges },
  ];

  // Freight paid-by-own / parent: supplier voucher total excludes freight
  const newFreightPaidBy: string = req.body.freightPaidBy ?? existingPO.freightPaidBy ?? "supplier";
  const newFreightOwnAccountId: number | null =
    req.body.freightOwnAccountId !== undefined
      ? req.body.freightOwnAccountId === null
        ? null
        : Number(req.body.freightOwnAccountId)
      : (existingPO.freightOwnAccountId ?? null);
  const newFreightParentAccountId: number | null =
    req.body.freightParentAccountId !== undefined
      ? req.body.freightParentAccountId === null
        ? null
        : Number(req.body.freightParentAccountId)
      : (existingPO.freightParentAccountId ?? null);
  const oldFreightPaidBy: string = existingPO.freightPaidBy ?? "supplier";

  // Use centralised calculator — single source of truth for both branches
  const { grossTotal: newGrandTotal, intercoTotal: supplierTotal } = calcPoAmountsExact({
    itemsTotal: newItemsTotal,
    freight: newFreight,
    surcharge: newSurcharge,
    fumigation: newFumigation,
    documentCharges: newDocumentCharges,
    discount: newDiscount,
    otherCharges: newOtherCharges,
    freightPaidBy: newFreightPaidBy,
  });
  const { grossTotal: oldGrandTotal, intercoTotal: oldSupplierTotal } = calcPoAmountsExact({
    itemsTotal: oldItemsTotal,
    freight: oldFreight,
    surcharge: oldSurcharge,
    fumigation: oldFumigation,
    documentCharges: oldDocumentCharges,
    discount: oldDiscount,
    otherCharges: oldOtherCharges,
    freightPaidBy: oldFreightPaidBy,
  });
  const freightPaidByChanged = newFreightPaidBy !== oldFreightPaidBy;
  const freightOwnAccountChanged = newFreightOwnAccountId !== (existingPO.freightOwnAccountId ?? null);
  const freightParentAccountChanged = newFreightParentAccountId !== (existingPO.freightParentAccountId ?? null);
  // Determine embedded-freight state (freight lives inside the purchase voucher)
  const newHasOwnFreight = newFreightPaidBy === "own" && newFreight.gt(0) && !!newFreightOwnAccountId;
  const newHasParentFreight = newFreightPaidBy === "parent" && newFreight.gt(0) && !!newFreightParentAccountId;
  const newHasEmbeddedFreight = newHasOwnFreight || newHasParentFreight;
  // Local voucher total = grossTotal when freight is parent-paid (child always owes
  // the parent the full amount including freight, regardless of whether the freight
  // account has been configured yet) or when freight is own-embedded.
  const newLocalVoucherTotal =
    newHasEmbeddedFreight || (newFreightPaidBy === "parent" && newFreight.gt(0)) ? newGrandTotal : supplierTotal;
  const oldHasEmbeddedFreight = oldFreightPaidBy === "own" || oldFreightPaidBy === "parent";
  const oldLocalVoucherTotal = oldHasEmbeddedFreight ? oldGrandTotal : oldSupplierTotal;
  const freightVoucherNeedsUpdate =
    newFreightPaidBy === "own" && (freightPaidByChanged || freightOwnAccountChanged || differs(newFreight, oldFreight));
  const freightParentVoucherNeedsUpdate =
    freightPaidByChanged ||
    freightParentAccountChanged ||
    (newFreightPaidBy === "parent" && differs(newFreight, oldFreight));

  return {
    done: false as const,
    id,
    existingPO,
    container,
    allowedUpdates,
    chargesWereEdited,
    newFreight,
    newSurcharge,
    newFumigation,
    newDocumentCharges,
    newDiscount,
    newOtherCharges,
    newItemsTotal,
    poChargeRows,
    newFreightPaidBy,
    newFreightOwnAccountId,
    newFreightParentAccountId,
    oldFreightPaidBy,
    newGrandTotal,
    supplierTotal,
    freightPaidByChanged,
    freightOwnAccountChanged,
    newHasOwnFreight,
    newHasParentFreight,
    newLocalVoucherTotal,
    oldLocalVoucherTotal,
    freightVoucherNeedsUpdate,
    freightParentVoucherNeedsUpdate,
  };
}
