import { parseId } from "../../lib/parseId";
import { HttpError, sendHttpError } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { logAudit } from "../_helpers";
import { containers, purchaseOrders, vouchers, voucherEntries, ledgerAccounts } from "@shared/schema";
import type { InsertPurchaseOrder } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  calcPoAmountsExact,
  differsByMoreThanTolerance as differs,
  isCreditOnlyEntry as isCreditOnly,
  isDebitOnlyEntry as isDebitOnly,
  syncIntercoParentVoucher,
} from "./containerHelpers";
import { moneyString, sumMoney, toMoney } from "../../lib/money";
import type Decimal from "decimal.js";
import { retireVouchersForRequestTx } from "../../services/accounting/voucherRetirement";

import { applyPurchaseOrderItemsUpdate } from "./purchaseOrderItemsUpdate";
import { storedCents, syncContainerCharges } from "./containerChargeSync";
import { registerPurchaseOrderDeleteRoute } from "./purchaseOrderDeleteRoute";
import { registerPoImportBackfillRoute } from "./poImportBackfillRoute";
import { syncPurchaseOrderGitTx } from "../../services/accounting/perpetualInventory/stockReceipts";

export function registerContainerFreightWriteRoutes(app: Express) {
  app.patch("/api/purchase-orders/:id", requireAuth, async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid purchase order ID" });
      }

      const existingPO = await storage.getPurchaseOrderByIdForCompany(id, req.session.currentCompanyId!);
      if (!existingPO) {
        return res.status(404).json({ message: "Purchase order not found" });
      }

      // Verify purchase order belongs to current company
      if (existingPO.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Purchase order belongs to a different company",
        });
      }

      // Check edit permissions based on role
      const userRole = req.session.currentRole;
      if (!userRole) {
        return res.status(403).json({ message: "User role not found" });
      }

      // Only Admin and Owner can edit purchase orders
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({ message: "Only Admin and Owner can edit purchase orders" });
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
            return res.status(400).json({
              message:
                "Cannot change stock items on an offloaded container. The inventory has already been added with the original items. Changing stock items would cause an import cycle imbalance. To fix this, first reverse the container offload, then edit the PO, then re-offload.",
            });
          }
        }
      }

      // Update line items if provided. The items path reprices the whole PO and
      // is a complete response on its own; it lives in ./purchaseOrderItemsUpdate.
      if (req.body.items && Array.isArray(req.body.items)) {
        return res.json(await applyPurchaseOrderItemsUpdate(req, { id, existingPO }));
      }

      // Only allow updating specific fields if no items provided
      const allowedUpdates: Partial<InsertPurchaseOrder> = {};
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
      const requestedLedgerAccountIds = [
        allowedUpdates.freightOwnAccountId,
        allowedUpdates.freightParentAccountId,
      ].filter((accountId): accountId is number => typeof accountId === "number");
      if (requestedLedgerAccountIds.length > 0) {
        const scopedAccounts = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, existingPO.companyId),
              inArray(ledgerAccounts.id, requestedLedgerAccountIds)
            )
          );
        const scopedAccountIds = new Set(scopedAccounts.map((account) => account.id));
        if (requestedLedgerAccountIds.some((accountId) => !scopedAccountIds.has(accountId))) {
          return res.status(400).json({
            message: "Freight ledger account must belong to the purchase order company",
          });
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
      const _newFreightAccountId = newHasParentFreight
        ? newFreightParentAccountId
        : newHasOwnFreight
          ? newFreightOwnAccountId
          : null;
      // Local voucher total = grossTotal when freight is parent-paid (child always owes
      // the parent the full amount including freight, regardless of whether the freight
      // account has been configured yet) or when freight is own-embedded.
      const newLocalVoucherTotal =
        newHasEmbeddedFreight || (newFreightPaidBy === "parent" && newFreight.gt(0)) ? newGrandTotal : supplierTotal;
      const oldHasEmbeddedFreight = oldFreightPaidBy === "own" || oldFreightPaidBy === "parent";
      const oldLocalVoucherTotal = oldHasEmbeddedFreight ? oldGrandTotal : oldSupplierTotal;
      const freightVoucherNeedsUpdate =
        newFreightPaidBy === "own" &&
        (freightPaidByChanged || freightOwnAccountChanged || differs(newFreight, oldFreight));
      const freightParentVoucherNeedsUpdate =
        freightPaidByChanged ||
        freightParentAccountChanged ||
        (newFreightPaidBy === "parent" && differs(newFreight, oldFreight));

      // Wave 7: the PO row, its voucher and lines, the freight voucher, the
      // container totals and charges, goods in transit, the inter-company
      // counterpart and the audit row commit together or not at all (they used
      // to be separate autocommit writes, so a failure part-way left the PO and
      // its ledger disagreeing).
      const updatedPO = await db.transaction(async (tx) => {
        // Serialize with other edits and the offload lifecycle on this PO, in the
        // offload lifecycle's lock order: container, then purchase order.
        if (existingPO.containerId != null) {
          await tx
            .select({ id: containers.id })
            .from(containers)
            .where(and(eq(containers.id, existingPO.containerId), eq(containers.companyId, existingPO.companyId)))
            .limit(1)
            .for("update");
        }
        const [lockedPO] = await tx
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, existingPO.companyId)))
          .limit(1)
          .for("update");
        if (!lockedPO) throw new HttpError(404, "Purchase order not found");

        // Update PO
        const [updated] =
          Object.keys(allowedUpdates).length > 0
            ? await tx.update(purchaseOrders).set(allowedUpdates).where(eq(purchaseOrders.id, id)).returning()
            : await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);

        // Fetch actual current voucher total from DB so we catch vouchers that were
        // created before the freight-embedding fix (their stored total is wrong even
        // though the PO fields haven't "changed").
        let actualDbVoucherTotal: Decimal | null = null;
        if (existingPO.voucherId) {
          const [currentVoucher] = await tx
            .select({ totalAmount: vouchers.totalAmount })
            .from(vouchers)
            .where(eq(vouchers.id, existingPO.voucherId))
            .limit(1);
          if (currentVoucher) {
            actualDbVoucherTotal = toMoney(currentVoucher.totalAmount);
          }
        }
        const voucherTotalMismatch =
          actualDbVoucherTotal !== null && differs(newLocalVoucherTotal, actualDbVoucherTotal);

        // Determine whether the PO is on the parent company (or no interco at all).
        // Used inside the transaction to pick the right voucher structure.
        const _pfParentId = await storage.getParentCompanyId();
        const _isSameCompanyOrNoInterco = !_pfParentId || existingPO.companyId === _pfParentId;
        const _poContainerNum = existingPO.containerId
          ? ((
              await tx
                .select({ containerNumber: containers.containerNumber })
                .from(containers)
                .where(eq(containers.id, existingPO.containerId))
                .limit(1)
            )[0]?.containerNumber ?? null)
          : null;
        const _freightNarration = `Freight - ${existingPO.poNumber}${_poContainerNum ? ` (${_poContainerNum})` : ""}`;

        // Update voucher entries when local voucher total, freight payer, or own-account changes,
        // OR when the actual DB voucher total doesn't match the expected total.
        if (
          voucherTotalMismatch ||
          differs(newLocalVoucherTotal, oldLocalVoucherTotal) ||
          freightPaidByChanged ||
          freightOwnAccountChanged ||
          freightVoucherNeedsUpdate ||
          freightParentVoucherNeedsUpdate
        ) {
          {
            // Update the purchase voucher linked to the PO
            if (
              existingPO.voucherId &&
              (voucherTotalMismatch ||
                differs(newLocalVoucherTotal, oldLocalVoucherTotal) ||
                freightPaidByChanged ||
                freightOwnAccountChanged ||
                freightParentVoucherNeedsUpdate)
            ) {
              // Update voucher total amount
              await tx
                .update(vouchers)
                .set({ totalAmount: moneyString(newLocalVoucherTotal) })
                .where(eq(vouchers.id, existingPO.voucherId));

              const existingEntries = await tx
                .select()
                .from(voucherEntries)
                .where(eq(voucherEntries.voucherId, existingPO.voucherId));

              if (newHasParentFreight && newFreightParentAccountId) {
                logger.info(
                  `[PO-PATCH charges] Freight posting: PO=${existingPO.poNumber} company=${existingPO.companyId} freightAcct=${newFreightParentAccountId} parentCoId=${_pfParentId} sameCompany=${_isSameCompanyOrNoInterco} freightAmt=${newFreight}`
                );

                if (_isSameCompanyOrNoInterco) {
                  // ── Same-company parent freight ──────────────────────────────────────
                  // The PO is on the parent company itself (or there is no interco config).
                  // The user pays freight themselves (not via the supplier), so freight is
                  // credited to the freight account (a payable) and the supplier is only
                  // credited for the goods amount.
                  // Structure:
                  //   DR Purchases (newGrandTotal — full cost incl. freight)
                  //   CR (supplier/payable entry) (supplierTotal — goods only)
                  //   CR freightParentAccountId (newFreight — freight payable)
                  //
                  // Strategy: keep first DR (purchases), keep first non-freight CR (supplier),
                  // keep/create freight CR at freightParentAccountId, delete extras.
                  let purchasesEntryId: number | null = null;
                  let mainCrEntryId: number | null = null;
                  const toDeleteIds: number[] = [];
                  const freightCrCandidatesPatch: number[] = [];

                  for (const entry of existingEntries) {
                    const acctId = entry.ledgerAccountId as number | null;
                    const isDebit = isDebitOnly(entry);
                    const isCredit = isCreditOnly(entry);

                    if (isCredit && acctId === newFreightParentAccountId) {
                      freightCrCandidatesPatch.push(entry.id);
                    } else if (isDebit && purchasesEntryId === null) {
                      purchasesEntryId = entry.id; // first DR = purchases
                    } else if (isCredit && mainCrEntryId === null) {
                      mainCrEntryId = entry.id; // first non-freight CR = supplier payable
                    } else {
                      toDeleteIds.push(entry.id); // extras — delete
                    }
                  }
                  const freightCrEntryId: number | null = freightCrCandidatesPatch[0] ?? null;
                  toDeleteIds.push(...freightCrCandidatesPatch.slice(1));

                  if (toDeleteIds.length > 0) {
                    await tx.delete(voucherEntries).where(inArray(voucherEntries.id, toDeleteIds));
                  }

                  // Update purchases DR to full gross amount (goods + freight)
                  if (purchasesEntryId !== null) {
                    await tx
                      .update(voucherEntries)
                      .set({ debitAmount: moneyString(newGrandTotal), creditAmount: "0" })
                      .where(eq(voucherEntries.id, purchasesEntryId));
                  }

                  // Update main CR to goods-only amount (supplier payable)
                  if (mainCrEntryId !== null) {
                    await tx
                      .update(voucherEntries)
                      .set({ creditAmount: moneyString(supplierTotal), debitAmount: "0" })
                      .where(eq(voucherEntries.id, mainCrEntryId));
                  }

                  // Update or insert freight CR entry pointing at freightParentAccountId
                  if (freightCrEntryId !== null) {
                    await tx
                      .update(voucherEntries)
                      .set({
                        creditAmount: moneyString(newFreight),
                        debitAmount: "0",
                        ledgerAccountId: newFreightParentAccountId,
                        narration: _freightNarration,
                      })
                      .where(eq(voucherEntries.id, freightCrEntryId));
                  } else {
                    await tx.insert(voucherEntries).values({
                      voucherId: existingPO.voucherId,
                      ledgerAccountId: newFreightParentAccountId,
                      debitAmount: "0",
                      creditAmount: moneyString(newFreight),
                      narration: _freightNarration,
                    });
                  }
                } else {
                  // ── Interco parent freight (subsidiary → parent company) ────────────
                  // Child's voucher never references freightParentAccountId directly.
                  // Structure:
                  //   DR Purchases (supplierTotal — goods)
                  //   DR Purchases (newFreight — freight, same purchases account)
                  //   CR parentCreditAccountId (newGrandTotal — full intercompany payable)
                  //
                  // Strategy: keep the parentCredit CR, delete everything else, rebuild DRs.
                  const childSettings = await storage.getCompanySettings(existingPO.companyId);
                  const parentCreditAcctId = childSettings?.parentCreditAccountId ?? null;

                  let parentCreditEntryId: number | null = null;
                  let purchasesAcctId: number | null = null;
                  const toDeleteIds: number[] = [];

                  for (const entry of existingEntries) {
                    const acctId = entry.ledgerAccountId as number | null;
                    const isDebit = isDebitOnly(entry);
                    const isCredit = isCreditOnly(entry);

                    if (isCredit && acctId === parentCreditAcctId && parentCreditEntryId === null) {
                      parentCreditEntryId = entry.id;
                    } else {
                      toDeleteIds.push(entry.id);
                      if (isDebit && acctId !== newFreightParentAccountId && !purchasesAcctId) {
                        purchasesAcctId = acctId;
                      }
                    }
                  }

                  if (toDeleteIds.length > 0) {
                    await tx.delete(voucherEntries).where(inArray(voucherEntries.id, toDeleteIds));
                  }

                  if (parentCreditEntryId !== null) {
                    await tx
                      .update(voucherEntries)
                      .set({ creditAmount: moneyString(newGrandTotal), debitAmount: "0" })
                      .where(eq(voucherEntries.id, parentCreditEntryId));
                  } else if (parentCreditAcctId) {
                    await tx.insert(voucherEntries).values({
                      voucherId: existingPO.voucherId,
                      ledgerAccountId: parentCreditAcctId,
                      debitAmount: "0",
                      creditAmount: moneyString(newGrandTotal),
                      narration: `PO ${existingPO.poNumber} - Credit to parent`,
                    });
                  }

                  if (purchasesAcctId) {
                    await tx.insert(voucherEntries).values([
                      {
                        voucherId: existingPO.voucherId,
                        ledgerAccountId: purchasesAcctId,
                        debitAmount: moneyString(supplierTotal),
                        creditAmount: "0",
                        narration: `${existingPO.poNumber}`,
                      },
                      {
                        voucherId: existingPO.voucherId,
                        ledgerAccountId: purchasesAcctId,
                        debitAmount: moneyString(newFreight),
                        creditAmount: "0",
                        narration: _freightNarration,
                      },
                    ]);
                  }
                }
              } else if (newHasOwnFreight && newFreightOwnAccountId) {
                // Own-paid freight: split inside purchase voucher
                //   DR Purchases (supplierTotal) + DR FreightOwn (newFreight)
                //   CR Supplier (supplierTotal)  + CR FreightOwn (newFreight)
                let purchasesAcctId: number | null = null;
                let freightCrFound = false;
                for (const entry of existingEntries) {
                  const isDebit = isDebitOnly(entry);
                  const isCredit = isCreditOnly(entry);
                  if (isDebit) {
                    if (!purchasesAcctId) purchasesAcctId = entry.ledgerAccountId ?? null;
                    if (entry.ledgerAccountId !== newFreightOwnAccountId) {
                      await tx
                        .update(voucherEntries)
                        .set({ debitAmount: moneyString(supplierTotal), creditAmount: "0" })
                        .where(eq(voucherEntries.id, entry.id));
                    } else {
                      // Existing freight DR entry — keep/update
                      await tx
                        .update(voucherEntries)
                        .set({ debitAmount: moneyString(newFreight) })
                        .where(eq(voucherEntries.id, entry.id));
                    }
                  } else if (isCredit) {
                    if (entry.ledgerAccountId === newFreightOwnAccountId) {
                      freightCrFound = true;
                      await tx
                        .update(voucherEntries)
                        .set({ creditAmount: moneyString(newFreight), ledgerAccountId: newFreightOwnAccountId })
                        .where(eq(voucherEntries.id, entry.id));
                    } else {
                      await tx
                        .update(voucherEntries)
                        .set({ creditAmount: moneyString(supplierTotal), debitAmount: "0" })
                        .where(eq(voucherEntries.id, entry.id));
                    }
                  }
                }
                if (!freightCrFound && purchasesAcctId) {
                  await tx.insert(voucherEntries).values([
                    {
                      voucherId: existingPO.voucherId,
                      ledgerAccountId: purchasesAcctId,
                      debitAmount: moneyString(newFreight),
                      creditAmount: "0",
                      narration: _freightNarration,
                    },
                    {
                      voucherId: existingPO.voucherId,
                      ledgerAccountId: newFreightOwnAccountId,
                      debitAmount: "0",
                      creditAmount: moneyString(newFreight),
                      narration: _freightNarration,
                    },
                  ]);
                }
              } else {
                // Standard: all entries to newLocalVoucherTotal (no embedded freight)
                // If switching away from embedded freight, remove freight entries first
                const freightEntryIds = existingEntries
                  .filter((e) => {
                    const acct = e.ledgerAccountId;
                    return (
                      acct === (existingPO.freightOwnAccountId ?? -1) ||
                      acct === (existingPO.freightParentAccountId ?? -1)
                    );
                  })
                  .map((e) => e.id);
                if (freightEntryIds.length > 0) {
                  await tx.delete(voucherEntries).where(inArray(voucherEntries.id, freightEntryIds));
                }
                // Also remove the matching freight DR entries (identified by narration)
                const remainingEntries = existingEntries.filter((e) => !freightEntryIds.includes(e.id));
                for (const entry of remainingEntries) {
                  if (toMoney(entry.debitAmount).gt(0)) {
                    await tx
                      .update(voucherEntries)
                      .set({ debitAmount: moneyString(newLocalVoucherTotal) })
                      .where(eq(voucherEntries.id, entry.id));
                  } else if (toMoney(entry.creditAmount).gt(0)) {
                    await tx
                      .update(voucherEntries)
                      .set({ creditAmount: moneyString(newLocalVoucherTotal) })
                      .where(eq(voucherEntries.id, entry.id));
                  }
                }
              }
            }

            // (interco sync moved to unconditional block below the transaction)

            // Update container totals if applicable
            const [container] = await tx
              .select()
              .from(containers)
              .where(and(eq(containers.id, existingPO.containerId), eq(containers.companyId, existingPO.companyId)))
              .limit(1);
            if (container) {
              // Get all POs for this container and recalculate totals
              const containerPOs = await tx
                .select()
                .from(purchaseOrders)
                .where(
                  and(
                    eq(purchaseOrders.companyId, existingPO.companyId),
                    eq(purchaseOrders.containerId, existingPO.containerId)
                  )
                );
              // Use the new values for this PO, the stored ones for the others.
              const poAmounts = containerPOs.map((po) =>
                po.id === id
                  ? {
                      itemsTotal: newItemsTotal,
                      freight: newFreight,
                      surcharge: newSurcharge,
                      fumigation: newFumigation,
                      documentCharges: newDocumentCharges,
                      discount: newDiscount,
                      otherCharges: newOtherCharges,
                    }
                  : po
              );
              const totalItemsCost = sumMoney(poAmounts.map((po) => po.itemsTotal));
              const totalCharges = sumMoney(
                poAmounts.flatMap((po) => [
                  po.freight,
                  po.surcharge,
                  po.fumigation,
                  po.documentCharges,
                  toMoney(po.discount).negated(),
                  po.otherCharges,
                ])
              );

              // Update container totals
              await tx
                .update(containers)
                .set({
                  itemsTotal: moneyString(totalItemsCost),
                  chargesTotal: moneyString(totalCharges),
                  grandTotal: moneyString(totalItemsCost.plus(totalCharges)),
                })
                .where(eq(containers.id, existingPO.containerId));
            }

            // Sync container_charges table when PO charges are edited
            if (chargesWereEdited && existingPO.containerId) {
              await syncContainerCharges(tx, existingPO.containerId, poChargeRows);
            }

            // ── Freight own-account voucher ───────────────────────────────────
            // When the user pays freight themselves, we create/update a separate
            // Payment voucher (Debit Purchases / Credit own account) so the
            // freight cost never touches the supplier's balance.
            const freightVoucherNum = `FREIGHT-${container?.containerNumber ?? existingPO.containerId}-${existingPO.poNumber}`;
            if (freightVoucherNeedsUpdate && newFreight.gt(0) && newFreightOwnAccountId) {
              // Find the Purchases account used as debit in the supplier voucher
              let purchasesAcctId: number | null = null;
              if (existingPO.voucherId) {
                const svEntries = await tx
                  .select()
                  .from(voucherEntries)
                  .where(eq(voucherEntries.voucherId, existingPO.voucherId));
                purchasesAcctId = svEntries.find((e) => toMoney(e.debitAmount).gt(0))?.ledgerAccountId ?? null;
              }
              const [existingFV] = await tx
                .select()
                .from(vouchers)
                .where(and(eq(vouchers.companyId, existingPO.companyId), eq(vouchers.voucherNumber, freightVoucherNum)))
                .limit(1);
              if (existingFV) {
                // Update existing freight voucher
                await tx
                  .update(vouchers)
                  .set({ totalAmount: moneyString(newFreight) })
                  .where(eq(vouchers.id, existingFV.id));
                const fEntries = await tx
                  .select()
                  .from(voucherEntries)
                  .where(eq(voucherEntries.voucherId, existingFV.id));
                for (const fe of fEntries) {
                  if (toMoney(fe.debitAmount).gt(0)) {
                    await tx
                      .update(voucherEntries)
                      .set({ debitAmount: moneyString(newFreight) })
                      .where(eq(voucherEntries.id, fe.id));
                  } else {
                    await tx
                      .update(voucherEntries)
                      .set({ creditAmount: moneyString(newFreight), ledgerAccountId: newFreightOwnAccountId })
                      .where(eq(voucherEntries.id, fe.id));
                  }
                }
              } else if (purchasesAcctId) {
                // Create new freight payment voucher
                const today = new Date().toISOString().split("T")[0];
                const [newFV] = await tx
                  .insert(vouchers)
                  .values({
                    companyId: existingPO.companyId,
                    voucherNumber: freightVoucherNum,
                    voucherType: "Payment",
                    voucherDate: today,
                    description: `Freight (own account) - ${container?.containerNumber} / ${existingPO.poNumber}`,
                    totalAmount: moneyString(newFreight),
                    sourceModule: "FACTORY",
                  })
                  .returning();
                await tx.insert(voucherEntries).values([
                  {
                    voucherId: newFV.id,
                    ledgerAccountId: purchasesAcctId,
                    debitAmount: moneyString(newFreight),
                    creditAmount: "0",
                    narration: `Freight - ${container?.containerNumber}`,
                  },
                  {
                    voucherId: newFV.id,
                    ledgerAccountId: newFreightOwnAccountId,
                    debitAmount: "0",
                    creditAmount: moneyString(newFreight),
                    narration: `Freight - ${container?.containerNumber}`,
                  },
                ]);
              }
            } else if (oldFreightPaidBy === "own" && newFreightPaidBy === "supplier") {
              // Switched back to supplier — remove the standalone freight voucher
              const [existingFV] = await tx
                .select()
                .from(vouchers)
                .where(and(eq(vouchers.companyId, existingPO.companyId), eq(vouchers.voucherNumber, freightVoucherNum)))
                .limit(1);
              // Wave 16 (A): retired (soft delete with its lines, audited), not hard-deleted.
              const fvIds = existingFV ? [existingFV.id] : [];
              await retireVouchersForRequestTx(tx, req, existingPO.companyId, fvIds, "po-freight-voucher-removed");
            }
          }
        } else if (chargesWereEdited && existingPO.containerId) {
          // If charges were edited but grand total didn't change (or no voucher), still sync container_charges
          await syncContainerCharges(tx, existingPO.containerId, poChargeRows);
        }

        // Perpetual inventory (wave 8.2): goods in transit follows the edited PO voucher.
        await syncPurchaseOrderGitTx(tx, existingPO.companyId, existingPO.id);

        // ── Inter-company sync — runs unconditionally after every charges-only update.
        // (Branch 1/items path runs its own sync inside the transaction above.)
        // Pass grossTotal (not supplierTotal) so the DR subsidiary entry is correct,
        // and include freight opts so the parent CR is split between supplier + freight account.
        {
          const _b2ParentId = await storage.getParentCompanyId();
          if (_b2ParentId && existingPO.companyId !== _b2ParentId) {
            const _b2NewPoNum =
              req.body.poNumber && req.body.poNumber !== existingPO.poNumber ? (req.body.poNumber as string) : null;
            const _b2PoNums = _b2NewPoNum ? [existingPO.poNumber, _b2NewPoNum] : existingPO.poNumber;
            const _b2ContainerRow = existingPO.containerId
              ? (
                  await tx
                    .select({ containerNumber: containers.containerNumber })
                    .from(containers)
                    .where(eq(containers.id, existingPO.containerId))
                    .limit(1)
                )[0]
              : undefined;
            const _b2Sync = await syncIntercoParentVoucher(
              tx,
              _b2PoNums,
              newGrandTotal,
              _b2ContainerRow?.containerNumber,
              newHasParentFreight && newFreightParentAccountId
                ? {
                    freightAmount: newFreight,
                    freightParentAccountId: newFreightParentAccountId,
                    subsidiaryCompanyId: existingPO.companyId,
                  }
                : undefined
            );
            if (!_b2Sync.found) {
              logger.warn(
                `[PO-PATCH charges] No INTERCO-PARENT voucher for PO(s): ${Array.isArray(_b2PoNums) ? _b2PoNums.join(", ") : _b2PoNums}`
              );
            }
          }
        }

        // INTERCO-FREIGHT sync removed — freight is now inside the purchase voucher itself.

        {
          const _poChanges: Record<string, { old: unknown; new: unknown }> = {};
          for (const _f of [
            "poNumber",
            "currency",
            "status",
            "freight",
            "surcharge",
            "fumigation",
            "documentCharges",
            "discount",
            "otherCharges",
            "itemsTotal",
          ] as const) {
            if (String(existingPO[_f] ?? "") !== String(updated[_f] ?? "")) {
              _poChanges[_f] = { old: existingPO[_f], new: updated[_f] };
            }
          }
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId: req.session.currentCompanyId!,
              action: "update",
              tableName: "purchase_orders",
              recordId: id,
              recordIdentifier: existingPO.poNumber || `PO #${id}`,
              changes: _poChanges,
            },
            tx
          );
        }
        return updated;
      });
      res.json(updatedPO);
    } catch (error: unknown) {
      sendHttpError(res, error);
    }
  });

  registerPurchaseOrderDeleteRoute(app);

  // Delete a container (Admin only)

  registerPoImportBackfillRoute(app);

  // Backfill voucher entries for existing sales
}
