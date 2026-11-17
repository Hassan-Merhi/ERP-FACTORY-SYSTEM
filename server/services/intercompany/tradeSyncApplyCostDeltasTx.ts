// Extracted from ./tradeSync.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { containers, intercompanyImportBatchContainers, purchaseOrders } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { sumMoney } from "../../lib/money";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { cents, fullPoCost, signedPair } from "./tradeRevisionMath";
import { isNettedIntercompanyTradeTx, rejectEdit, type TradeData } from "./tradeSyncLoadTradeTx";

/** Exact source PO deltas, mirrored sale/COGS and destination GIT/supplier payable, without touching old vouchers. */
export async function applyCostDeltasTx(
  tx: DbTransaction,
  data: TradeData,
  input: {
    revisionId: number;
    postingDate: string;
    reason: string;
    actorUserId: string;
    poDeltas: {
      poId: number;
      goods: Decimal;
      charge: Decimal;
      chargeField?: "freight" | "surcharge" | "fumigation" | "documentCharges" | "otherCharges";
    }[];
  }
) {
  const p = data.policy,
    original = new Map(data.source.map((g) => [g.po.id, g.po]));
  const netted = await isNettedIntercompanyTradeTx(tx, data.trade.id);
  const goodsDelta = sumMoney(input.poDeltas.map((x) => x.goods));
  const chargesDelta = sumMoney(input.poDeltas.map((x) => x.charge));
  const totalDelta = goodsDelta.plus(chargesDelta);
  const before = fullPoCost(data.destination.po);
  const after = before.plus(totalDelta);
  if (!after.gt(0)) rejectEdit("Confirmed landed cost must stay positive");
  const vouchers: number[] = [];
  for (const change of input.poDeltas) {
    if (change.goods.isZero() && change.charge.isZero()) continue;
    const po = original.get(change.poId);
    if (!po) rejectEdit("Source PO does not belong to the linked container");
    const lines = [
      ...signedPair(
        { ledgerAccountId: p.sourcePurchaseAccountId! },
        { supplierId: po.supplierId },
        change.goods,
        "External supplier price adjustment, PO " + po.poNumber
      ),
      ...signedPair(
        { ledgerAccountId: p.sourcePurchaseAccountId! },
        netted ? { supplierId: po.supplierId } : { ledgerAccountId: p.sourceChargeAccrualAccountId! },
        change.charge,
        "Confirmed charge accrual adjustment, PO " + po.poNumber
      ),
    ];
    const voucher = await postErpVoucherTx(tx, {
      companyId: data.trade.sourceCompanyId,
      voucherType: "Journal",
      voucherDate: input.postingDate,
      sourceModule: "INTERCOMPANY_CONTAINER",
      description: "Original PO adjustment: " + po.poNumber,
      source: { type: "ic-phase3-source-adjustment", id: input.revisionId, revision: po.id },
      actor: { userId: input.actorUserId, reason: input.reason },
      lines,
    });
    vouchers.push(voucher.voucher.id);
    const update: Partial<typeof purchaseOrders.$inferInsert> = {};
    if (!change.goods.isZero()) {
      const goods = cents(po.itemsTotal ?? "0").plus(change.goods);
      if (goods.lt(0)) rejectEdit("Original supplier PO items cannot become negative");
      update.itemsTotal = goods.toFixed(2);
    }
    if (!change.charge.isZero()) {
      const field = change.chargeField;
      if (!field) rejectEdit("Confirmed charge has no mapped charge type");
      const value = cents(po[field] ?? "0").plus(change.charge);
      if (value.lt(0)) rejectEdit("Confirmed source PO charge cannot become negative");
      update[field] = value.toFixed(2);
      update.chargesEdited = true;
    }
    await tx.update(purchaseOrders).set(update).where(eq(purchaseOrders.id, po.id));
  }
  if (!totalDelta.isZero()) {
    for (const step of [
      {
        companyId: data.trade.sourceCompanyId,
        key: "source-sale",
        lines: signedPair(
          { ledgerAccountId: p.sourceReceivableAccountId! },
          { ledgerAccountId: p.sourceSalesAccountId! },
          totalDelta,
          "At-cost intercompany resale adjustment"
        ),
      },
      {
        companyId: data.trade.sourceCompanyId,
        key: "source-cost",
        lines: signedPair(
          { ledgerAccountId: p.sourceCostAccountId! },
          { ledgerAccountId: p.sourcePurchaseAccountId! },
          totalDelta,
          "Cost of goods sold reclassification"
        ).concat(
          netted
            ? signedPair(
                { ledgerAccountId: p.sourceSalesAccountId! },
                { ledgerAccountId: p.sourceCostAccountId! },
                totalDelta,
                "Eliminate internal sales and COGS at cost"
              )
            : []
        ),
      },
      {
        companyId: data.trade.destinationCompanyId,
        key: "destination-git",
        lines: signedPair(
          { ledgerAccountId: p.destinationGitAccountId! },
          { supplierId: p.destinationSupplierId! },
          totalDelta,
          "Destination GIT / Hassan Properties supplier payable"
        ),
      },
    ]) {
      const posted = await postErpVoucherTx(tx, {
        companyId: step.companyId,
        voucherType: "Journal",
        voucherDate: input.postingDate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Atomic linked cost adjustment",
        source: { type: "ic-phase3-" + step.key, id: input.revisionId },
        actor: { userId: input.actorUserId, reason: input.reason },
        lines: step.lines,
      });
      vouchers.push(posted.voucher.id);
    }
  }
  if (!totalDelta.isZero()) {
    const update: Partial<typeof purchaseOrders.$inferInsert> = {};
    if (!goodsDelta.isZero())
      update.itemsTotal = cents(data.destination.po.itemsTotal ?? "0")
        .plus(goodsDelta)
        .toFixed(2);
    if (!chargesDelta.isZero()) {
      const fields = [...new Set(input.poDeltas.filter((x) => !x.charge.isZero()).map((x) => x.chargeField))];
      if (fields.length !== 1 || !fields[0]) rejectEdit("A confirmed revision must use one charge type");
      const field = fields[0],
        value = cents(data.destination.po[field] ?? "0").plus(chargesDelta);
      if (value.lt(0)) rejectEdit("Destination confirmed charge cannot become negative");
      update[field] = value.toFixed(2);
      update.chargesEdited = true;
    }
    await tx.update(purchaseOrders).set(update).where(eq(purchaseOrders.id, data.destination.po.id));
    await tx
      .update(containers)
      .set({
        ...(!goodsDelta.isZero()
          ? {
              itemsTotal: cents(data.physical.itemsTotal ?? "0")
                .plus(goodsDelta)
                .toFixed(2),
            }
          : {}),
        ...(!chargesDelta.isZero()
          ? {
              chargesTotal: cents(data.physical.chargesTotal ?? "0")
                .plus(chargesDelta)
                .toFixed(2),
            }
          : {}),
        grandTotal: after.toFixed(2),
      })
      .where(eq(containers.id, data.physical.id));
    await tx
      .update(intercompanyImportBatchContainers)
      .set({
        confirmedLandedCost: after.toFixed(2),
        ...(!chargesDelta.isZero() ? { chargesConfirmed: true } : {}),
      })
      .where(eq(intercompanyImportBatchContainers.id, data.imported.id));
  }
  return { amountAfter: after.toFixed(2), vouchers };
}
