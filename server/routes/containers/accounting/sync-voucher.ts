/**
 * containerAccountingRoutes: ContainerSyncVoucher endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { containers, purchaseOrders, vouchers, voucherEntries, suppliers } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { calcPoAmountsExact, syncIntercoParentVoucher } from "../containerHelpers";
import { toMoney } from "../../../lib/money";
import { syncPurchaseOrderGitTx } from "../../../services/accounting/perpetualInventory/stockReceipts";

export function registerContainerSyncVoucherRoutes(app: Express) {
  // Sync purchase voucher amounts for a container's POs (fixes cases where voucher
  // was created before line items were imported, resulting in $0 amounts)
  app.post("/api/containers/:id/sync-voucher", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const [container] = await db
        .select({ id: containers.id, containerNumber: containers.containerNumber, companyId: containers.companyId })
        .from(containers)
        .where(and(eq(containers.id, id), eq(containers.companyId, companyId)))
        .limit(1);
      if (!container) return res.status(404).json({ message: "Container not found" });

      const pos = await db.select().from(purchaseOrders).where(eq(purchaseOrders.containerId, id));

      const parentCompanyId = await storage.getParentCompanyId();
      let updatedLocalVouchers = 0;
      let updatedParentVouchers = 0;
      const skipped: string[] = [];
      const errors: string[] = [];

      for (const po of pos) {
        const { grossTotal: poTotal, intercoTotal: poIntercoTotal } = calcPoAmountsExact({
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
        const poFreight = toMoney(po.freight);
        const poFreightParentAccountId: number | null = po.freightParentAccountId
          ? Number(po.freightParentAccountId)
          : null;
        const poFreightOwnAccountId: number | null = po.freightOwnAccountId ? Number(po.freightOwnAccountId) : null;
        const hasParentFreight = poFreightPaidBy === "parent" && poFreight.gt(0) && !!poFreightParentAccountId;
        const hasOwnFreight = poFreightPaidBy === "own" && poFreight.gt(0) && !!poFreightOwnAccountId;
        const hasEmbeddedFreight = hasParentFreight || hasOwnFreight;
        // Which account to credit for freight inside the purchase voucher
        const freightAccountId = hasParentFreight
          ? poFreightParentAccountId
          : hasOwnFreight
            ? poFreightOwnAccountId
            : null;

        // Local voucher amount: grossTotal when freight is embedded, intercoTotal otherwise.
        const poLocalTotal = hasEmbeddedFreight ? poTotal : poIntercoTotal;

        if (poTotal.lte(0)) {
          skipped.push(`PO ${po.poNumber}: total is 0`);
          continue;
        }

        // Fix the purchase voucher linked directly to the PO
        if (po.voucherId) {
          const poVoucherId = po.voucherId;
          await db.transaction(async (tx) => {
            await tx
              .update(vouchers)
              .set({ totalAmount: poLocalTotal.toFixed(2) })
              .where(eq(vouchers.id, poVoucherId));

            // Also update the description to use the current container number
            const [voucherRow] = await tx
              .select({ id: vouchers.id, description: vouchers.description })
              .from(vouchers)
              .where(eq(vouchers.id, poVoucherId))
              .limit(1);
            if (voucherRow && po.supplierId) {
              const [sup] = await tx
                .select({ legalName: suppliers.legalName })
                .from(suppliers)
                .where(eq(suppliers.id, po.supplierId))
                .limit(1);
              const expectedDesc = [container.containerNumber, sup?.legalName].filter(Boolean).join(" ");
              if (voucherRow.description && !voucherRow.description.includes(container.containerNumber)) {
                await tx.update(vouchers).set({ description: expectedDesc }).where(eq(vouchers.id, voucherRow.id));
              }
            }

            const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, poVoucherId));

            if (hasParentFreight && poFreightParentAccountId) {
              // Parent-paid freight: child's voucher must NEVER reference the parent's
              // freightParentAccountId. Correct structure:
              //   DR Purchases (intercoTotal — goods)
              //   DR Purchases (freight — same account)
              //   CR parentCreditAccountId (grossTotal — full intercompany payable)
              //
              // Strategy: locate the single parent-credit CR entry to preserve, then
              // DELETE everything else and rebuild DR entries fresh so a previously
              // bad sync (with double DRs) cannot leave stale entries behind.
              const childSettings = await storage.getCompanySettings(po.companyId);
              const parentCreditAcctId = childSettings?.parentCreditAccountId ?? null;

              let parentCreditEntryId: number | null = null;
              let purchasesAcctId: number | null = null;
              const toDeleteIds: number[] = [];

              for (const entry of entries) {
                const acctId = entry.ledgerAccountId as number | null;
                const isDebit = toMoney(entry.debitAmount).gt(0) && toMoney(entry.creditAmount).isZero();
                const isCredit = toMoney(entry.creditAmount).gt(0) && toMoney(entry.debitAmount).isZero();

                if (isCredit && acctId === parentCreditAcctId && parentCreditEntryId === null) {
                  // Keep this one — we'll update it to grossTotal
                  parentCreditEntryId = entry.id;
                } else {
                  // Everything else (wrong freight DRs/CRs, extra goods DRs, etc.) — delete
                  toDeleteIds.push(entry.id);
                  // Capture purchases account from any non-freight DR
                  if (isDebit && acctId !== poFreightParentAccountId && !purchasesAcctId) {
                    purchasesAcctId = acctId;
                  }
                }
              }

              // Delete all stale entries in one shot
              if (toDeleteIds.length > 0) {
                await tx.delete(voucherEntries).where(inArray(voucherEntries.id, toDeleteIds));
              }

              // Update or insert the parent credit CR (grossTotal)
              if (parentCreditEntryId !== null) {
                await tx
                  .update(voucherEntries)
                  .set({ creditAmount: poTotal.toFixed(2), debitAmount: "0" })
                  .where(eq(voucherEntries.id, parentCreditEntryId));
              } else if (parentCreditAcctId) {
                await tx.insert(voucherEntries).values({
                  voucherId: poVoucherId,
                  ledgerAccountId: parentCreditAcctId,
                  debitAmount: "0",
                  creditAmount: poTotal.toFixed(2),
                  narration: `PO ${po.poNumber} - Credit to parent`,
                });
              }

              // Re-insert goods DR + freight DR fresh
              if (purchasesAcctId) {
                await tx.insert(voucherEntries).values([
                  {
                    voucherId: poVoucherId,
                    ledgerAccountId: purchasesAcctId,
                    debitAmount: poIntercoTotal.toFixed(2),
                    creditAmount: "0",
                    narration: `${po.poNumber}`,
                  },
                  {
                    voucherId: poVoucherId,
                    ledgerAccountId: purchasesAcctId,
                    debitAmount: poFreight.toFixed(2),
                    creditAmount: "0",
                    narration: `Freight - ${po.poNumber}${container.containerNumber ? ` (${container.containerNumber})` : ""}`,
                  },
                ]);
              }
            } else if (hasOwnFreight) {
              // Own-paid freight: DR Purchases (intercoTotal) + DR FreightOwnAccount (freight)
              //                   CR Supplier (intercoTotal) + CR FreightOwnAccount (freight)
              // Identify freight CR entry by ledgerAccountId = freightAccountId (own)
              let purchasesAcctId: number | null = null;
              let freightCrFound = false;
              for (const entry of entries) {
                const isDebit = toMoney(entry.debitAmount).gt(0) && toMoney(entry.creditAmount).isZero();
                const isCredit = toMoney(entry.creditAmount).gt(0) && toMoney(entry.debitAmount).isZero();
                if (isDebit) {
                  if (!purchasesAcctId) purchasesAcctId = entry.ledgerAccountId ?? null;
                  // Goods DR entry — update to intercoTotal; freight DR will be added/kept separately
                  if (entry.ledgerAccountId !== freightAccountId) {
                    await tx
                      .update(voucherEntries)
                      .set({ debitAmount: poIntercoTotal.toFixed(2), creditAmount: "0" })
                      .where(eq(voucherEntries.id, entry.id));
                  }
                } else if (isCredit) {
                  if (entry.ledgerAccountId === freightAccountId) {
                    // Freight CR entry — update to current freight amount
                    freightCrFound = true;
                    await tx
                      .update(voucherEntries)
                      .set({ creditAmount: poFreight.toFixed(2) })
                      .where(eq(voucherEntries.id, entry.id));
                  } else {
                    // Goods CR entry (supplier account) — update to intercoTotal
                    await tx
                      .update(voucherEntries)
                      .set({ creditAmount: poIntercoTotal.toFixed(2), debitAmount: "0" })
                      .where(eq(voucherEntries.id, entry.id));
                  }
                }
              }
              // If no freight CR entry exists yet, add the freight pair
              if (!freightCrFound && purchasesAcctId) {
                await tx.insert(voucherEntries).values([
                  {
                    voucherId: poVoucherId,
                    ledgerAccountId: purchasesAcctId,
                    debitAmount: poFreight.toFixed(2),
                    creditAmount: "0",
                    narration: `Freight - ${po.poNumber}${container.containerNumber ? ` (${container.containerNumber})` : ""}`,
                  },
                  {
                    voucherId: poVoucherId,
                    ledgerAccountId: freightAccountId,
                    debitAmount: "0",
                    creditAmount: poFreight.toFixed(2),
                    narration: `Freight - ${po.poNumber}${container.containerNumber ? ` (${container.containerNumber})` : ""}`,
                  },
                ]);
              }
            } else {
              // Standard: update all entries to poLocalTotal
              for (const entry of entries) {
                const origDebit = toMoney(entry.debitAmount);
                const origCredit = toMoney(entry.creditAmount);
                let isDebitEntry: boolean;
                if (origDebit.gt(0) && origCredit.isZero()) {
                  isDebitEntry = true;
                } else if (origCredit.gt(0) && origDebit.isZero()) {
                  isDebitEntry = false;
                } else {
                  const nar = (entry.narration || "").toLowerCase();
                  isDebitEntry = !entry.supplierId && (nar.includes("purchases") || nar.includes("owes us"));
                }
                if (isDebitEntry) {
                  await tx
                    .update(voucherEntries)
                    .set({ debitAmount: poLocalTotal.toFixed(2), creditAmount: "0" })
                    .where(eq(voucherEntries.id, entry.id));
                } else {
                  await tx
                    .update(voucherEntries)
                    .set({ creditAmount: poLocalTotal.toFixed(2), debitAmount: "0" })
                    .where(eq(voucherEntries.id, entry.id));
                }
              }
            }
          });
          updatedLocalVouchers++;
        }

        // Fix the INTERCO-PARENT voucher in the parent company
        if (parentCompanyId && po.companyId !== parentCompanyId) {
          const svResult = await syncIntercoParentVoucher(
            db,
            po.poNumber,
            poTotal,
            container.containerNumber,
            hasParentFreight
              ? {
                  freightAmount: poFreight,
                  freightParentAccountId: poFreightParentAccountId!,
                  subsidiaryCompanyId: po.companyId,
                }
              : undefined
          );
          if (svResult.updated) {
            updatedParentVouchers++;
          } else if (!svResult.found) {
            skipped.push(`PO ${po.poNumber}: no INTERCO-PARENT voucher found`);
          }
        }
      }

      // Perpetual inventory (wave 8.2): goods in transit follows the synced PO vouchers.
      await db.transaction(async (tx) => {
        for (const po of pos) await syncPurchaseOrderGitTx(tx, companyId, po.id);
      });

      res.json({
        message: `Synced ${updatedLocalVouchers} local voucher(s) and ${updatedParentVouchers} parent JV(s)`,
        updatedVouchers: updatedLocalVouchers + updatedParentVouchers,
        updatedLocalVouchers,
        updatedParentVouchers,
        skipped,
        errors,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Auto-generate the next available PO number for the current company.
  // Format: PO-{YYYY}-{NNN} — scans existing PO numbers and returns the next
  // unused sequence so every new PO gets a unique, trackable identifier.
}
