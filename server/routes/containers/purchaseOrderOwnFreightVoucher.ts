/**
 * Own-account freight voucher of the purchase-order PATCH route (split out of
 * containerFreightWriteRoutes.ts). When the user pays freight themselves, a
 * separate Payment voucher (Debit Purchases / Credit own account) is created
 * or updated so the freight cost never touches the supplier's balance; when
 * freight switches back to the supplier, that voucher is retired.
 */
import type { Request } from "express";
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { vouchers, voucherEntries } from "@shared/schema";
import type { Container, PurchaseOrder } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { moneyString, toMoney } from "../../lib/money";
import { retireVouchersForRequestTx } from "../../services/accounting/voucherRetirement";
import { postFactoryVoucherTx, usdLineAmounts } from "../../services/factory/factoryVoucherPosting";
import { editPostedFactoryVoucherTx } from "../../services/factory/factoryVoucherCorrection";

export interface PurchaseOrderOwnFreightSyncInput {
  existingPO: PurchaseOrder;
  container: Container | undefined;
  newFreight: Decimal;
  newFreightOwnAccountId: number | null;
  newFreightPaidBy: string;
  oldFreightPaidBy: string;
  freightVoucherNeedsUpdate: boolean;
}

export async function syncPurchaseOrderOwnFreightVoucherTx(
  tx: DbTransaction,
  req: Request,
  {
    existingPO,
    container,
    newFreight,
    newFreightOwnAccountId,
    newFreightPaidBy,
    oldFreightPaidBy,
    freightVoucherNeedsUpdate,
  }: PurchaseOrderOwnFreightSyncInput
): Promise<void> {
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
      // Update existing freight voucher (audited open-period edit; 409 when closed)
      await editPostedFactoryVoucherTx(
        tx,
        {
          companyId: existingPO.companyId,
          voucherIds: [existingFV.id],
          reason: "purchase-order-own-freight-resync",
          actor: { userId: req.session.userId, username: req.session.username },
        },
        async () => {
          await tx
            .update(vouchers)
            .set({ totalAmount: moneyString(newFreight) })
            .where(eq(vouchers.id, existingFV.id));
          const fEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, existingFV.id));
          for (const fe of fEntries) {
            if (toMoney(fe.debitAmount).gt(0)) {
              await tx
                .update(voucherEntries)
                .set(usdLineAmounts(moneyString(newFreight), 0))
                .where(eq(voucherEntries.id, fe.id));
            } else {
              await tx
                .update(voucherEntries)
                .set({
                  ...usdLineAmounts(0, moneyString(newFreight)),
                  ledgerAccountId: newFreightOwnAccountId,
                })
                .where(eq(voucherEntries.id, fe.id));
            }
          }
        }
      );
    } else if (purchasesAcctId) {
      // Create new freight payment voucher — through the engine with the
      // PO's posting identity; the FREIGHT-{container}-{po} number is read
      // back by number above, so it is kept.
      const today = new Date().toISOString().split("T")[0];
      await postFactoryVoucherTx(tx, {
        companyId: existingPO.companyId,
        voucherNumber: freightVoucherNum,
        voucherType: "Payment",
        voucherDate: today,
        description: `Freight (own account) - ${container?.containerNumber} / ${existingPO.poNumber}`,
        source: { sourceType: "purchase-order-own-freight", sourceId: existingPO.id, phase: "voucher" },
        lines: [
          {
            ledgerAccountId: purchasesAcctId,
            debit: newFreight,
            narration: `Freight - ${container?.containerNumber}`,
          },
          {
            ledgerAccountId: newFreightOwnAccountId,
            credit: newFreight,
            narration: `Freight - ${container?.containerNumber}`,
          },
        ],
      });
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
