// Extracted from ./containerFreightReadRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../../lib/parseId";
import { getErrorMessage, sendHttpError } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { containers, ledgerAccounts, purchaseOrders, voucherEntries, vouchers } from "@shared/schema";
import { and, asc, eq, inArray, like, isNull } from "drizzle-orm";
import { ledgerPostingLeafCondition } from "../../services/accounting/postableLedgerAccountPolicy";
import { calcPoAmountsExact, isCreditOnlyEntry, isDebitOnlyEntry, syncIntercoParentVoucher } from "./containerHelpers";
import { toMoney } from "../../lib/money";
import { runWithVerifiedPoParentScope } from "../../services/security/parentCompanyPostingScope";
import { usdLineAmounts } from "../../services/factory/factoryVoucherPosting";
import {
  editPostedFactoryVoucherTx,
  sendVoucherCorrectionRefusal,
} from "../../services/factory/factoryVoucherCorrection";

export function registerContainerFreightReadRoutesPart1(app: Express) {
  app.get("/api/purchase-orders/next-po-number", requireAuth, requireNonPOS, async (req, res) => {
    try {
      // req.user never carries companyId (requireAuth builds it without one), so this
      // stays undefined and the route answers 400, as pinned in config/api-smoke-shapes.json.
      // Reading the session instead would be a behaviour change, not a type fix.
      const companyId = (req.user as { companyId?: number } | undefined)?.companyId;
      if (!companyId) return res.status(400).json({ message: "No company in session" });

      const year = new Date().getFullYear();
      const prefix = `PO-${year}-`;

      // Fetch all PO numbers for this company that match the auto-format
      const rows = await db
        .select({ poNumber: purchaseOrders.poNumber })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.companyId, companyId), like(purchaseOrders.poNumber, `${prefix}%`)));

      // Extract the numeric suffix and find the highest
      let maxSeq = 0;
      for (const { poNumber } of rows) {
        const suffix = poNumber.slice(prefix.length);
        const n = parseInt(suffix, 10);
        if (!isNaN(n) && n > maxSeq) maxSeq = n;
      }

      const next = String(maxSeq + 1).padStart(3, "0");
      res.json({ poNumber: `${prefix}${next}` });
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Ledger accounts from the parent company — used for "Parent pays freight" picker
  app.get("/api/purchase-orders/parent-freight-accounts", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const parentCompanyId = await storage.getParentCompanyId();
      if (!parentCompanyId) return res.status(404).json({ message: "No parent company configured" });
      const accounts = await db
        .select({
          id: ledgerAccounts.id,
          name: ledgerAccounts.name,
          code: ledgerAccounts.code,
          accountType: ledgerAccounts.accountType,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, parentCompanyId),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.deletedAt),
            ledgerPostingLeafCondition(parentCompanyId)
          )
        )
        .orderBy(asc(ledgerAccounts.name));
      res.json(accounts);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Per-PO parent JV sync endpoint
  app.post("/api/purchase-orders/:id/sync-parent-voucher", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const po = await storage.getPurchaseOrderByIdForCompany(id, companyId);
      if (!po) return res.status(404).json({ message: "Purchase order not found" });
      if (po.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

      const parentCompanyId = await storage.getParentCompanyId();
      const isSameCompanySync = !parentCompanyId || po.companyId === parentCompanyId;

      const { grossTotal: poGrossTotal, intercoTotal: poSupplierTotal } = calcPoAmountsExact({
        itemsTotal: po.itemsTotal,
        freight: po.freight,
        surcharge: po.surcharge,
        fumigation: po.fumigation,
        documentCharges: po.documentCharges,
        discount: po.discount,
        otherCharges: po.otherCharges,
        freightPaidBy: po.freightPaidBy,
      });
      const poFreightPaidBy: string = po.freightPaidBy || "supplier";
      const poFreightAmt = toMoney(po.freight);
      const poFreightParentAcctId: number | null = po.freightParentAccountId ? Number(po.freightParentAccountId) : null;
      const poHasParentFreight = poFreightPaidBy === "parent" && poFreightAmt.greaterThan(0) && !!poFreightParentAcctId;

      // Fetch container number up-front — used in both the same-company and interco paths.
      // Must be declared before isSameCompanySync block to avoid Temporal Dead Zone crash.
      const poContainerRow = po.containerId
        ? (
            await db
              .select({ containerNumber: containers.containerNumber })
              .from(containers)
              .where(eq(containers.id, po.containerId))
              .limit(1)
          )[0]
        : undefined;

      // Same-company / no interco: update the freight DR entry in the PO's local voucher.
      if (isSameCompanySync) {
        if (!poHasParentFreight || !po.voucherId) {
          return res.json({
            message: "No parent company freight configured — nothing to sync",
            found: false,
            updated: false,
          });
        }
        // Update the PO voucher entries: DR Purchases (grossTotal), CR Supplier (supplierTotal), CR Freight Account (freight).
        const existingEntries = await db
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, po.voucherId!));
        let purchasesEntryId: number | null = null;
        let freightCrEntryId: number | null = null;
        let mainCrEntryId: number | null = null;
        const toDeleteIds: number[] = [];
        const freightCrCandidates: number[] = [];
        for (const entry of existingEntries) {
          const acctId = entry.ledgerAccountId as number | null;
          const isDebit = isDebitOnlyEntry(entry);
          const isCredit = isCreditOnlyEntry(entry);
          if (isCredit && acctId === poFreightParentAcctId) {
            freightCrCandidates.push(entry.id);
          } else if (isDebit && purchasesEntryId === null) {
            purchasesEntryId = entry.id;
          } else if (isCredit && mainCrEntryId === null) {
            mainCrEntryId = entry.id;
          } else {
            toDeleteIds.push(entry.id);
          }
        }
        freightCrEntryId = freightCrCandidates[0] ?? null;
        toDeleteIds.push(...freightCrCandidates.slice(1));
        await db.transaction((tx) =>
          editPostedFactoryVoucherTx(
            tx,
            {
              companyId: po.companyId,
              voucherIds: [po.voucherId!],
              reason: "purchase-order-sync-parent-voucher",
              actor: { userId: req.session.userId, username: req.session.username },
            },
            async () => {
              if (toDeleteIds.length > 0)
                await tx.delete(voucherEntries).where(inArray(voucherEntries.id, toDeleteIds));
              if (purchasesEntryId !== null)
                await tx
                  .update(voucherEntries)
                  .set(usdLineAmounts(poGrossTotal.toFixed(2), 0))
                  .where(eq(voucherEntries.id, purchasesEntryId));
              if (mainCrEntryId !== null)
                await tx
                  .update(voucherEntries)
                  .set(usdLineAmounts(0, poSupplierTotal.toFixed(2)))
                  .where(eq(voucherEntries.id, mainCrEntryId));
              const _syncBtnFreightNarration = `Freight - ${po.poNumber}${poContainerRow?.containerNumber ? ` (${poContainerRow.containerNumber})` : ""}`;
              if (freightCrEntryId !== null) {
                await tx
                  .update(voucherEntries)
                  .set({
                    ...usdLineAmounts(0, poFreightAmt.toFixed(2)),
                    ledgerAccountId: poFreightParentAcctId!,
                    narration: _syncBtnFreightNarration,
                  })
                  .where(eq(voucherEntries.id, freightCrEntryId));
              } else {
                await tx.insert(voucherEntries).values({
                  voucherId: po.voucherId!,
                  ledgerAccountId: poFreightParentAcctId!,
                  ...usdLineAmounts(0, poFreightAmt.toFixed(2)),
                  narration: _syncBtnFreightNarration,
                });
              }
              await tx
                .update(vouchers)
                .set({ totalAmount: poGrossTotal.toFixed(2) })
                .where(eq(vouchers.id, po.voucherId!));
            }
          )
        );
        return res.json({
          message: `Freight posted to account — PO voucher updated (${poFreightAmt.toFixed(2)})`,
          found: true,
          updated: true,
          amount: poGrossTotal.toFixed(2),
          poNumber: po.poNumber,
          updatedVouchers: 1,
        });
      }

      const result = await runWithVerifiedPoParentScope(po.companyId, async (verifiedParentId) => {
        if (!verifiedParentId) throw new Error("This company has no verified parent company for intercompany credit.");
        return syncIntercoParentVoucher(
          db,
          po.poNumber,
          poGrossTotal,
          poContainerRow?.containerNumber,
          poHasParentFreight
            ? {
                freightAmount: poFreightAmt,
                freightParentAccountId: poFreightParentAcctId!,
                subsidiaryCompanyId: po.companyId,
              }
            : undefined,
          verifiedParentId,
          po.companyId
        );
      });

      if (result.found) {
        return res.json({
          message: `Parent JV synced — voucher #${result.voucherId} updated to ${result.amount}`,
          ...result,
          poNumber: po.poNumber,
          intercoTotal: result.amount,
          updatedVouchers: result.updated ? 1 : 0,
        });
      }

      return res.status(409).json({
        message: `No matching parent intercompany journal for container ${poContainerRow?.containerNumber ?? "unknown"}; nothing was changed.`,
        found: false,
        updated: false,
        poNumber: po.poNumber,
      });
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      sendHttpError(res, error);
    }
  });
}
