// Extracted from ./containerTradingImport.ts to keep that module under the source-size cap.
import { eq } from "drizzle-orm";
import {
  containerCharges,
  containers,
  intercompanyAuditEvents,
  intercompanyImportBatchContainers,
  intercompanyTradeLineLinks,
  intercompanyTrades,
  intercompanyTradeSourcePos,
  poLineItems,
  purchaseOrders,
} from "@shared/schema";
import type { DbTransaction } from "../../db";
import { type ErpVoucherLine, postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { destinationContainerGitPostingLines } from "./containerDestinationPosting";
import { technicalProfitNettingLines } from "./technicalProfitNetting";
import { autoAllocateNewTradeCreditTx } from "./paymentAllocationCore";
import { assert, generatedPoNumber, money } from "./containerTradingWorkbook";
import { postIntercompanyImportTxStep1, postIntercompanyImportTxStep2 } from "./getTradingSetup";

export async function postIntercompanyImportTxStep3(
  {
    batch,
    external,
    input,
    mapped,
    preview,
    results,
    source,
    sourceCompanyId,
    usedNumbers,
    userId,
  }: Pick<
    Awaited<ReturnType<typeof postIntercompanyImportTxStep1>> &
      Awaited<ReturnType<typeof postIntercompanyImportTxStep2>>,
    | "batch"
    | "external"
    | "input"
    | "mapped"
    | "preview"
    | "results"
    | "source"
    | "sourceCompanyId"
    | "usedNumbers"
    | "userId"
  >,
  tx: DbTransaction
) {
  for (const { plan, policy, items, accounts: acct } of mapped) {
    const [physical] = await tx
      .insert(containers)
      .values({
        companyId: sourceCompanyId,
        containerNumber: plan.containerNumber,
        supplierId: external.id,
        status: "OTW",
        importDate: input.importDate,
        itemsTotal: plan.goodsTotal,
        chargesTotal: plan.chargesNet,
        grandTotal: plan.landedTotal,
      })
      .returning();

    const sourcePoIds: number[] = [];
    const supplierVoucherIds: number[] = [];
    const sourceLineIdsByExcelRow = new Map<number, number>();
    for (const [index, group] of plan.sourcePos.entries()) {
      const key = preview.sha256 + ":" + plan.containerNumber + ":" + index;
      let poNumber = group.originalPoNumber || generatedPoNumber("HP-EXT-", plan.containerNumber, key);
      if (usedNumbers.has(sourceCompanyId + ":" + poNumber))
        poNumber = generatedPoNumber("HP-EXT-", plan.containerNumber, key);
      assert(!usedNumbers.has(sourceCompanyId + ":" + poNumber), "Source PO number collision");
      usedNumbers.add(sourceCompanyId + ":" + poNumber);

      // The selected supplier receives the FULL landed PO total by default,
      // including freight and other charges; never leave a hidden charge payable.
      const lines: ErpVoucherLine[] = [
        {
          ledgerAccountId: acct.purchase,
          debit: group.grandTotal,
          narration: "External goods and confirmed landed cost",
        },
      ];
      if (money(group.supplierCredit).gt(0))
        lines.push({
          supplierId: external.id,
          credit: group.supplierCredit,
          narration: "Eurogulf/external supplier payable",
        });
      // Dedicated third-party charge payees require an explicit import
      // allocation feature; no such payee is selected in this workflow.
      const journal = await postErpVoucherTx(tx, {
        companyId: sourceCompanyId,
        voucherType: "Purchase",
        voucherDate: input.importDate,
        description: "Original supplier PO " + (group.originalPoNumber || poNumber) + " - " + plan.containerNumber,
        lines,
        source: { type: "ic-container-external", id: batch.id + ":" + physical.id + ":" + index },
        actor: { userId, reason: "Intercompany at-cost external purchase" },
      });
      const [sourcePo] = await tx
        .insert(purchaseOrders)
        .values({
          companyId: sourceCompanyId,
          poNumber,
          containerId: physical.id,
          supplierId: external.id,
          voucherId: journal.voucher.id,
          currency: "USD",
          itemsTotal: group.itemsTotal,
          freight: group.freight,
          surcharge: group.surcharge,
          fumigation: group.fumigation,
          documentCharges: group.documentCharges,
          discount: group.discount,
          otherCharges: group.otherCharges,
          status: "Open",
        })
        .returning();
      const insertedSourceLines = await tx
        .insert(poLineItems)
        .values(
          group.lines.map((line) => {
            const stockMatch = items.find((i) => i.line === line)!;
            return {
              poId: sourcePo.id,
              stockItemId: stockMatch.sourceItemId,
              itemName: line.itemName,
              quantity: line.quantity,
              rate: line.rate,
              lineTotal: line.lineTotal,
            };
          })
        )
        .returning({ id: poLineItems.id });
      assert(insertedSourceLines.length === group.lines.length, "Source PO line insertion was incomplete");
      group.lines.forEach((line, index) => {
        assert(!sourceLineIdsByExcelRow.has(line.rowNum), "Original Excel row is not uniquely identified");
        sourceLineIdsByExcelRow.set(line.rowNum, insertedSourceLines[index].id);
      });
      sourcePoIds.push(sourcePo.id);
      supplierVoucherIds.push(journal.voucher.id);
    }

    const targetPoNumber = generatedPoNumber(
      "HP-IC-",
      plan.containerNumber,
      sourceCompanyId + ":" + policy.destinationCompanyId + ":" + plan.containerNumber
    );
    assert(
      !usedNumbers.has(policy.destinationCompanyId + ":" + targetPoNumber),
      "A destination PO with this number already exists"
    );
    usedNumbers.add(policy.destinationCompanyId + ":" + targetPoNumber);
    const destVoucher = await postErpVoucherTx(tx, {
      companyId: policy.destinationCompanyId,
      voucherType: "Purchase",
      voucherDate: input.importDate,
      description: source.name + " linked container purchase - " + plan.containerNumber,
      lines: destinationContainerGitPostingLines({
        goodsInTransitLedgerAccountId: acct.git,
        propertiesSupplierId: policy.destinationSupplierId!,
        confirmedLandedCost: plan.landedTotal,
        sourceCompanyName: source.name,
      }),
      source: { type: "ic-container-destination", id: batch.id + ":" + physical.id },
      actor: { userId, reason: "Paired at-cost purchase, not an external payment" },
    });
    const [destPo] = await tx
      .insert(purchaseOrders)
      .values({
        companyId: policy.destinationCompanyId,
        poNumber: targetPoNumber,
        containerId: physical.id,
        supplierId: policy.destinationSupplierId!,
        voucherId: destVoucher.voucher.id,
        currency: "USD",
        itemsTotal: plan.goodsTotal,
        ...plan.charges,
        status: "Open",
      })
      .returning();
    const insertedDestinationLines = await tx
      .insert(poLineItems)
      .values(
        items.map(({ line, destItemId }) => ({
          poId: destPo.id,
          stockItemId: destItemId,
          itemName: line.itemName,
          quantity: line.quantity,
          rate: line.rate,
          lineTotal: line.lineTotal,
        }))
      )
      .returning({ id: poLineItems.id });
    assert(insertedDestinationLines.length === items.length, "Destination PO lines were incomplete");

    const [trade] = await tx
      .insert(intercompanyTrades)
      .values({
        relationshipId: policy.id,
        physicalContainerId: physical.id,
        sourceCompanyId,
        destinationCompanyId: policy.destinationCompanyId,
        originalSupplierPoId: sourcePoIds[0],
        destinationPoId: destPo.id,
        state: "pending",
      })
      .returning();
    await tx.insert(intercompanyTradeSourcePos).values(
      plan.sourcePos.map((p, index) => ({
        tradeId: trade.id,
        sourcePoId: sourcePoIds[index],
        originalPoNumber: p.originalPoNumber || "(blank in workbook)",
      }))
    );
    // Immutable row mapping avoids guessing by item names, barcodes or order on later edits.
    await tx.insert(intercompanyTradeLineLinks).values(
      items.map(({ line }, index) => {
        const sourceLineId = sourceLineIdsByExcelRow.get(line.rowNum);
        assert(
          sourceLineId && insertedDestinationLines[index]?.id,
          "Missing verified original-to-destination row link"
        );
        return {
          tradeId: trade.id,
          sourceLineId,
          destinationLineId: insertedDestinationLines[index].id,
          originalExcelRow: line.rowNum,
        };
      })
    );
    const saleVoucher = await postErpVoucherTx(tx, {
      companyId: sourceCompanyId,
      voucherType: "Sales",
      voucherDate: input.importDate,
      description: "At-cost container resale to " + policy.destinationCompanyId + " - " + plan.containerNumber,
      lines: [
        { ledgerAccountId: acct.ar, debit: plan.landedTotal, narration: "Intercompany receivable" },
        {
          ledgerAccountId: acct.sales,
          credit: plan.landedTotal,
          narration: "Intercompany sales at full confirmed cost",
        },
      ],
      source: { type: "ic-container-source-sale", id: trade.id },
      actor: { userId, reason: "Zero-markup intercompany resale" },
    });
    // Reclassify purchased cost to COGS when HP immediately resells the goods.
    // Purchases nets to zero, and sale proceeds exactly equal COGS (no markup).
    const costVoucher = await postErpVoucherTx(tx, {
      companyId: sourceCompanyId,
      voucherType: "Journal",
      voucherDate: input.importDate,
      description: "At-cost goods transferred out - " + plan.containerNumber,
      lines: [
        { ledgerAccountId: acct.cogs, debit: plan.landedTotal, narration: "Internal transfer cost" },
        { ledgerAccountId: acct.purchase, credit: plan.landedTotal, narration: "Release original purchase cost" },
        // Same-voucher technical netting: the transfer is at cost and is
        // NOT external revenue or a realized COGS expense for Properties.
        // Leave just Dr intercompany balance / Cr original supplier in
        // the source company's final ledger balances.
        ...technicalProfitNettingLines(acct.sales, acct.cogs, plan.landedTotal),
      ],
      source: { type: "ic-container-source-cost", id: trade.id },
      actor: { userId, reason: "Cost of goods sold on at-cost intercompany resale" },
    });
    for (const [name, value] of [
      ["Freight", plan.charges.freight],
      ["Surcharge", plan.charges.surcharge],
      ["Fumigation", plan.charges.fumigation],
      ["Document Charges", plan.charges.documentCharges],
      ["Discount", money(plan.charges.discount).negated().toFixed(2)],
    ] as const)
      if (!money(value).isZero()) {
        await tx.insert(containerCharges).values({ containerId: physical.id, chargeType: name, amount: value });
      }
    await tx.update(intercompanyTrades).set({ state: "active" }).where(eq(intercompanyTrades.id, trade.id));
    await tx.insert(intercompanyImportBatchContainers).values({
      batchId: batch.id,
      containerNumber: plan.containerNumber,
      destinationCompanyId: policy.destinationCompanyId,
      physicalContainerId: physical.id,
      tradeId: trade.id,
      chargesConfirmed: plan.chargesConfirmed,
      chargeEvidenceReference:
        plan.chargeEvidenceReference ?? (plan.chargesConfirmed ? `PO workbook SHA-256: ${preview.sha256}` : null),
      confirmedLandedCost: plan.landedTotal,
    });
    // Only at NEW PO import: reuse older verified credit of this exact company pair.
    // Credit allocation has no voucher entries; the original cash receipt already posted.
    const previousCredit = await autoAllocateNewTradeCreditTx(tx, {
      tradeId: trade.id,
      relationshipId: policy.id,
      confirmedLandedCost: plan.landedTotal,
    });
    await tx.insert(intercompanyAuditEvents).values({
      eventKey: "ic-container-import:" + batch.id + ":" + trade.id,
      relationshipId: policy.id,
      sourceCompanyId,
      actorUserId: userId,
      eventType: "container-import-confirmed",
      sourceReference: preview.sha256,
      payload: {
        physicalContainerId: physical.id,
        sourcePoIds,
        originalSupplierVoucherIds: supplierVoucherIds,
        sourceSaleVoucherId: saleVoucher.voucher.id,
        sourceCostVoucherId: costVoucher.voucher.id,
        technicalProfitNetting: true,
        destinationPoId: destPo.id,
        destinationVoucherId: destVoucher.voucher.id,
        destinationStockItemIds: items.map((item) => item.destItemId),
        autoCreatedDestinationStockItemIds: items
          .filter((item) => item.destinationItemAutoCreated)
          .map((item) => item.destItemId),
        landedCost: plan.landedTotal,
        previousCreditAllocated: previousCredit.applied,
        unpaidAfterExistingCredit: previousCredit.remainingDue,
        chargesConfirmed: plan.chargesConfirmed,
        chargeEvidenceReference: plan.chargeEvidenceReference,
        proposedCharges: plan.proposedCharges,
      },
    });
    results.push({
      containerNumber: plan.containerNumber,
      containerId: physical.id,
      destinationCompanyId: policy.destinationCompanyId,
      sourcePoIds,
      destinationPoId: destPo.id,
      tradeId: trade.id,
      landedTotal: plan.landedTotal,
    });
  }
  return {};
}
