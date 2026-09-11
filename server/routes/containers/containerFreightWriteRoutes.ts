import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { logAudit } from "../_helpers";
import { containers, containerCharges, vouchers, voucherEntries, ledgerAccounts } from "@shared/schema";
import type { InsertPurchaseOrder } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { calcPoAmounts, syncIntercoParentVoucher } from "./containerHelpers";
import { applyPurchaseOrderItemsUpdate } from "./purchaseOrderItemsUpdate";
import { registerPoImportBackfillRoute } from "./poImportBackfillRoute";

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
      const newFreight = parseFloat(req.body.freight ?? existingPO.freight ?? "0");
      const newSurcharge = parseFloat(req.body.surcharge ?? existingPO.surcharge ?? "0");
      const newFumigation = parseFloat(req.body.fumigation ?? existingPO.fumigation ?? "0");
      const newDocumentCharges = parseFloat(req.body.documentCharges ?? existingPO.documentCharges ?? "0");
      const newDiscount = parseFloat(req.body.discount ?? existingPO.discount ?? "0");
      const newOtherCharges = parseFloat(req.body.otherCharges ?? existingPO.otherCharges ?? "0");
      const newItemsTotal = parseFloat(req.body.itemsTotal ?? existingPO.itemsTotal ?? "0");
      const oldFreight = parseFloat(existingPO.freight || "0");
      const oldSurcharge = parseFloat(existingPO.surcharge || "0");
      const oldFumigation = parseFloat(existingPO.fumigation || "0");
      const oldDocumentCharges = parseFloat(existingPO.documentCharges || "0");
      const oldDiscount = parseFloat(existingPO.discount || "0");
      const oldOtherCharges = parseFloat(existingPO.otherCharges || "0");
      const oldItemsTotal = parseFloat(existingPO.itemsTotal || "0");

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
      const { grossTotal: newGrandTotal, intercoTotal: supplierTotal } = calcPoAmounts({
        itemsTotal: newItemsTotal,
        freight: newFreight,
        surcharge: newSurcharge,
        fumigation: newFumigation,
        documentCharges: newDocumentCharges,
        discount: newDiscount,
        otherCharges: newOtherCharges,
        freightPaidBy: newFreightPaidBy,
      });
      const { grossTotal: oldGrandTotal, intercoTotal: oldSupplierTotal } = calcPoAmounts({
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
      const newHasOwnFreight = newFreightPaidBy === "own" && newFreight > 0 && !!newFreightOwnAccountId;
      const newHasParentFreight = newFreightPaidBy === "parent" && newFreight > 0 && !!newFreightParentAccountId;
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
        newHasEmbeddedFreight || (newFreightPaidBy === "parent" && newFreight > 0) ? newGrandTotal : supplierTotal;
      const oldHasEmbeddedFreight = oldFreightPaidBy === "own" || oldFreightPaidBy === "parent";
      const oldLocalVoucherTotal = oldHasEmbeddedFreight ? oldGrandTotal : oldSupplierTotal;
      const freightVoucherNeedsUpdate =
        newFreightPaidBy === "own" &&
        (freightPaidByChanged || freightOwnAccountChanged || Math.abs(newFreight - oldFreight) > 0.001);
      const freightParentVoucherNeedsUpdate =
        freightPaidByChanged ||
        freightParentAccountChanged ||
        (newFreightPaidBy === "parent" && Math.abs(newFreight - oldFreight) > 0.001);

      // Update PO
      const updated = await storage.updatePurchaseOrder(id, allowedUpdates);

      // Fetch actual current voucher total from DB so we catch vouchers that were
      // created before the freight-embedding fix (their stored total is wrong even
      // though the PO fields haven't "changed").
      let actualDbVoucherTotal: number | null = null;
      if (existingPO.voucherId) {
        const [currentVoucher] = await db
          .select({ totalAmount: vouchers.totalAmount })
          .from(vouchers)
          .where(eq(vouchers.id, existingPO.voucherId))
          .limit(1);
        if (currentVoucher) {
          actualDbVoucherTotal = parseFloat(currentVoucher.totalAmount || "0");
        }
      }
      const voucherTotalMismatch =
        actualDbVoucherTotal !== null && Math.abs(newLocalVoucherTotal - actualDbVoucherTotal) > 0.001;

      // Determine whether the PO is on the parent company (or no interco at all).
      // Used inside the transaction to pick the right voucher structure.
      const _pfParentId = await storage.getParentCompanyId();
      const _isSameCompanyOrNoInterco = !_pfParentId || existingPO.companyId === _pfParentId;
      const _poContainerNum = existingPO.containerId
        ? ((
            await db
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
        Math.abs(newLocalVoucherTotal - oldLocalVoucherTotal) > 0.001 ||
        freightPaidByChanged ||
        freightOwnAccountChanged ||
        freightVoucherNeedsUpdate ||
        freightParentVoucherNeedsUpdate
      ) {
        await db.transaction(async (tx) => {
          // Update the purchase voucher linked to the PO
          if (
            existingPO.voucherId &&
            (voucherTotalMismatch ||
              Math.abs(newLocalVoucherTotal - oldLocalVoucherTotal) > 0.001 ||
              freightPaidByChanged ||
              freightOwnAccountChanged ||
              freightParentVoucherNeedsUpdate)
          ) {
            // Update voucher total amount
            await tx
              .update(vouchers)
              .set({ totalAmount: newLocalVoucherTotal.toFixed(2) })
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
                  const isDebit =
                    parseFloat(entry.debitAmount || "0") > 0 && parseFloat(entry.creditAmount || "0") === 0;
                  const isCredit =
                    parseFloat(entry.creditAmount || "0") > 0 && parseFloat(entry.debitAmount || "0") === 0;

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
                    .set({ debitAmount: newGrandTotal.toFixed(2), creditAmount: "0" })
                    .where(eq(voucherEntries.id, purchasesEntryId));
                }

                // Update main CR to goods-only amount (supplier payable)
                if (mainCrEntryId !== null) {
                  await tx
                    .update(voucherEntries)
                    .set({ creditAmount: supplierTotal.toFixed(2), debitAmount: "0" })
                    .where(eq(voucherEntries.id, mainCrEntryId));
                }

                // Update or insert freight CR entry pointing at freightParentAccountId
                if (freightCrEntryId !== null) {
                  await tx
                    .update(voucherEntries)
                    .set({
                      creditAmount: newFreight.toFixed(2),
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
                    creditAmount: newFreight.toFixed(2),
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
                  const isDebit =
                    parseFloat(entry.debitAmount || "0") > 0 && parseFloat(entry.creditAmount || "0") === 0;
                  const isCredit =
                    parseFloat(entry.creditAmount || "0") > 0 && parseFloat(entry.debitAmount || "0") === 0;

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
                    .set({ creditAmount: newGrandTotal.toFixed(2), debitAmount: "0" })
                    .where(eq(voucherEntries.id, parentCreditEntryId));
                } else if (parentCreditAcctId) {
                  await tx.insert(voucherEntries).values({
                    voucherId: existingPO.voucherId,
                    ledgerAccountId: parentCreditAcctId,
                    debitAmount: "0",
                    creditAmount: newGrandTotal.toFixed(2),
                    narration: `PO ${existingPO.poNumber} - Credit to parent`,
                  });
                }

                if (purchasesAcctId) {
                  await tx.insert(voucherEntries).values([
                    {
                      voucherId: existingPO.voucherId,
                      ledgerAccountId: purchasesAcctId,
                      debitAmount: supplierTotal.toFixed(2),
                      creditAmount: "0",
                      narration: `${existingPO.poNumber}`,
                    },
                    {
                      voucherId: existingPO.voucherId,
                      ledgerAccountId: purchasesAcctId,
                      debitAmount: newFreight.toFixed(2),
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
                const isDebit = parseFloat(entry.debitAmount || "0") > 0 && parseFloat(entry.creditAmount || "0") === 0;
                const isCredit =
                  parseFloat(entry.creditAmount || "0") > 0 && parseFloat(entry.debitAmount || "0") === 0;
                if (isDebit) {
                  if (!purchasesAcctId) purchasesAcctId = entry.ledgerAccountId ?? null;
                  if (entry.ledgerAccountId !== newFreightOwnAccountId) {
                    await tx
                      .update(voucherEntries)
                      .set({ debitAmount: supplierTotal.toFixed(2), creditAmount: "0" })
                      .where(eq(voucherEntries.id, entry.id));
                  } else {
                    // Existing freight DR entry — keep/update
                    await tx
                      .update(voucherEntries)
                      .set({ debitAmount: newFreight.toFixed(2) })
                      .where(eq(voucherEntries.id, entry.id));
                  }
                } else if (isCredit) {
                  if (entry.ledgerAccountId === newFreightOwnAccountId) {
                    freightCrFound = true;
                    await tx
                      .update(voucherEntries)
                      .set({ creditAmount: newFreight.toFixed(2), ledgerAccountId: newFreightOwnAccountId })
                      .where(eq(voucherEntries.id, entry.id));
                  } else {
                    await tx
                      .update(voucherEntries)
                      .set({ creditAmount: supplierTotal.toFixed(2), debitAmount: "0" })
                      .where(eq(voucherEntries.id, entry.id));
                  }
                }
              }
              if (!freightCrFound && purchasesAcctId) {
                await tx.insert(voucherEntries).values([
                  {
                    voucherId: existingPO.voucherId,
                    ledgerAccountId: purchasesAcctId,
                    debitAmount: newFreight.toFixed(2),
                    creditAmount: "0",
                    narration: _freightNarration,
                  },
                  {
                    voucherId: existingPO.voucherId,
                    ledgerAccountId: newFreightOwnAccountId,
                    debitAmount: "0",
                    creditAmount: newFreight.toFixed(2),
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
                if (parseFloat(entry.debitAmount || "0") > 0) {
                  await tx
                    .update(voucherEntries)
                    .set({ debitAmount: newLocalVoucherTotal.toFixed(2) })
                    .where(eq(voucherEntries.id, entry.id));
                } else if (parseFloat(entry.creditAmount || "0") > 0) {
                  await tx
                    .update(voucherEntries)
                    .set({ creditAmount: newLocalVoucherTotal.toFixed(2) })
                    .where(eq(voucherEntries.id, entry.id));
                }
              }
            }
          }

          // (interco sync moved to unconditional block below the transaction)

          // Update container totals if applicable
          const container = await storage.getContainerByIdForCompany(existingPO.containerId, existingPO.companyId);
          if (container) {
            // Get all POs for this container and recalculate totals
            const allPOs = await storage.getAllPurchaseOrders(existingPO.companyId);
            const containerPOs = allPOs.filter((po) => po.containerId === existingPO.containerId);
            let totalItemsCost = 0;
            let totalCharges = 0;

            for (const po of containerPOs) {
              if (po.id === id) {
                // Use the new values for this PO
                totalItemsCost += newItemsTotal;
                totalCharges +=
                  newFreight + newSurcharge + newFumigation + newDocumentCharges - newDiscount + newOtherCharges;
              } else {
                totalItemsCost += parseFloat(po.itemsTotal || "0");
                totalCharges +=
                  parseFloat(po.freight || "0") +
                  parseFloat(po.surcharge || "0") +
                  parseFloat(po.fumigation || "0") +
                  parseFloat(po.documentCharges || "0") -
                  parseFloat(po.discount || "0") +
                  parseFloat(po.otherCharges || "0");
              }
            }

            // Update container totals
            const chargesTotal = totalCharges;
            await tx
              .update(containers)
              .set({
                itemsTotal: totalItemsCost.toFixed(2),
                chargesTotal: chargesTotal.toFixed(2),
                grandTotal: (totalItemsCost + chargesTotal).toFixed(2),
              })
              .where(eq(containers.id, existingPO.containerId));
          }

          // Sync container_charges table when PO charges are edited
          if (chargesWereEdited && existingPO.containerId) {
            const chargeTypeMap = [
              { field: "freight", chargeType: "Freight", amount: newFreight },
              { field: "surcharge", chargeType: "Surcharge", amount: newSurcharge },
              { field: "fumigation", chargeType: "Fumigation", amount: newFumigation },
              { field: "documentCharges", chargeType: "Document Charges", amount: newDocumentCharges },
              { field: "discount", chargeType: "Discount", amount: -newDiscount }, // Discount stored as negative
              { field: "otherCharges", chargeType: "Other Charges", amount: newOtherCharges },
            ];

            for (const { chargeType, amount } of chargeTypeMap) {
              // Find existing container charge entry
              const existingCharge = await tx
                .select()
                .from(containerCharges)
                .where(
                  and(
                    eq(containerCharges.containerId, existingPO.containerId),
                    eq(containerCharges.chargeType, chargeType)
                  )
                )
                .limit(1);

              if (amount === 0) {
                // Delete entry if charge is 0
                if (existingCharge.length > 0) {
                  await tx.delete(containerCharges).where(eq(containerCharges.id, existingCharge[0].id));
                }
              } else {
                // Upsert: update if exists, insert if not
                if (existingCharge.length > 0) {
                  await tx
                    .update(containerCharges)
                    .set({ amount: amount.toFixed(2) })
                    .where(eq(containerCharges.id, existingCharge[0].id));
                } else {
                  await tx.insert(containerCharges).values({
                    containerId: existingPO.containerId,
                    chargeType: chargeType,
                    amount: amount.toFixed(2),
                  });
                }
              }
            }
          }

          // ── Freight own-account voucher ───────────────────────────────────
          // When the user pays freight themselves, we create/update a separate
          // Payment voucher (Debit Purchases / Credit own account) so the
          // freight cost never touches the supplier's balance.
          const freightVoucherNum = `FREIGHT-${container?.containerNumber ?? existingPO.containerId}-${existingPO.poNumber}`;
          if (freightVoucherNeedsUpdate && newFreight > 0 && newFreightOwnAccountId) {
            // Find the Purchases account used as debit in the supplier voucher
            let purchasesAcctId: number | null = null;
            if (existingPO.voucherId) {
              const svEntries = await tx
                .select()
                .from(voucherEntries)
                .where(eq(voucherEntries.voucherId, existingPO.voucherId));
              purchasesAcctId = svEntries.find((e) => parseFloat(e.debitAmount || "0") > 0)?.ledgerAccountId ?? null;
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
                .set({ totalAmount: newFreight.toFixed(2) })
                .where(eq(vouchers.id, existingFV.id));
              const fEntries = await tx
                .select()
                .from(voucherEntries)
                .where(eq(voucherEntries.voucherId, existingFV.id));
              for (const fe of fEntries) {
                if (parseFloat(fe.debitAmount || "0") > 0) {
                  await tx
                    .update(voucherEntries)
                    .set({ debitAmount: newFreight.toFixed(2) })
                    .where(eq(voucherEntries.id, fe.id));
                } else {
                  await tx
                    .update(voucherEntries)
                    .set({ creditAmount: newFreight.toFixed(2), ledgerAccountId: newFreightOwnAccountId })
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
                  totalAmount: newFreight.toFixed(2),
                  sourceModule: "FACTORY",
                })
                .returning();
              await tx.insert(voucherEntries).values([
                {
                  voucherId: newFV.id,
                  ledgerAccountId: purchasesAcctId,
                  debitAmount: newFreight.toFixed(2),
                  creditAmount: "0",
                  narration: `Freight - ${container?.containerNumber}`,
                },
                {
                  voucherId: newFV.id,
                  ledgerAccountId: newFreightOwnAccountId,
                  debitAmount: "0",
                  creditAmount: newFreight.toFixed(2),
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
            if (existingFV) {
              await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, existingFV.id));
              await tx.delete(vouchers).where(eq(vouchers.id, existingFV.id));
            }
          }
        });
      } else if (chargesWereEdited && existingPO.containerId) {
        // If charges were edited but grand total didn't change (or no voucher), still sync container_charges
        const chargeTypeMap = [
          { field: "freight", chargeType: "Freight", amount: newFreight },
          { field: "surcharge", chargeType: "Surcharge", amount: newSurcharge },
          { field: "fumigation", chargeType: "Fumigation", amount: newFumigation },
          { field: "documentCharges", chargeType: "Document Charges", amount: newDocumentCharges },
          { field: "discount", chargeType: "Discount", amount: -newDiscount }, // Discount stored as negative
          { field: "otherCharges", chargeType: "Other Charges", amount: newOtherCharges },
        ];

        for (const { chargeType, amount } of chargeTypeMap) {
          // Find existing container charge entry
          const existingCharge = await db
            .select()
            .from(containerCharges)
            .where(
              and(eq(containerCharges.containerId, existingPO.containerId), eq(containerCharges.chargeType, chargeType))
            )
            .limit(1);

          if (amount === 0) {
            // Delete entry if charge is 0
            if (existingCharge.length > 0) {
              await db.delete(containerCharges).where(eq(containerCharges.id, existingCharge[0].id));
            }
          } else {
            // Upsert: update if exists, insert if not
            if (existingCharge.length > 0) {
              await db
                .update(containerCharges)
                .set({ amount: amount.toFixed(2) })
                .where(eq(containerCharges.id, existingCharge[0].id));
            } else {
              await db.insert(containerCharges).values({
                containerId: existingPO.containerId,
                chargeType: chargeType,
                amount: amount.toFixed(2),
              });
            }
          }
        }
      }

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
                await db
                  .select({ containerNumber: containers.containerNumber })
                  .from(containers)
                  .where(eq(containers.id, existingPO.containerId))
                  .limit(1)
              )[0]
            : undefined;
          const _b2Sync = await syncIntercoParentVoucher(
            db,
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

      try {
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
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "purchase_orders",
          recordId: id,
          recordIdentifier: existingPO.poNumber || `PO #${id}`,
          changes: _poChanges,
        });
      } catch {
        /* non-fatal */
      }
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Delete a purchase order (Admin only)
  app.delete("/api/purchase-orders/:id", requireAuth, requireRole("Admin"), async (req, res) => {
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

      await storage.deletePurchaseOrder(id);
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "delete",
          tableName: "purchase_orders",
          recordId: existingPO.id,
          recordIdentifier: existingPO.poNumber || `PO #${id}`,
          changes: {
            poNumber: { old: existingPO.poNumber },
            supplier: { old: existingPO.supplierId },
            itemsTotal: { old: existingPO.itemsTotal || "0" },
            status: { old: existingPO.status },
          },
        });
      } catch {
        /* non-fatal */
      }
      res.json({ message: "Purchase order deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Delete a container (Admin only)

  registerPoImportBackfillRoute(app);

  // Backfill voucher entries for existing sales
}
