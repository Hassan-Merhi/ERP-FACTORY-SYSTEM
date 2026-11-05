/**
 * Phase 2: one physical container, one confirmed landed-cost resale per destination.
 * Source and destination POs, all vouchers, evidence and audit records share one
 * transaction. Caller must have verified the configured company pairs and opened
 * an authorized cross-company database scope before invoking this function.
 */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  companies,
  companyScopedSuppliers,
  containerCharges,
  containers,
  importLogs,
  intercompanyAuditEvents,
  intercompanyImportBatchContainers,
  intercompanyImportBatches,
  intercompanyReconciliationFindings,
  intercompanyReconciliationRuns,
  intercompanyRelationshipPolicies,
  intercompanyTrades,
  intercompanyTradeSourcePos,
  poLineItems,
  purchaseOrders,
  stockItems,
  type IntercompanyRelationshipPolicy,
} from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { toMoney, type MoneyInput } from "../../lib/money";
import { postErpVoucherTx, pairLines, type ErpVoucherLine } from "../accounting/erpVoucherPosting";
import { allocatePoCharges, type PoChargeSplit } from "../../routes/import/poChargeAllocation";
import type { ParsedContainerPreview, ParsedItemRow } from "../../routes/import/poImportExcelParser";

const DECIMAL_ZERO = new Decimal(0);
const IMPORT_LOCK_NAMESPACE = 916_204;

export class ContainerTradeImportError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ContainerTradeImportError";
  }
}

const fail = (message: string, code = "INTERCOMPANY_IMPORT_INVALID", status = 422): never => {
  throw new ContainerTradeImportError(status, code, message);
};
const currency = (value: MoneyInput): Decimal => toMoney(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T12:00:00Z"));

export type ContainerTradeSelection = {
  containerNumber: string;
  destinationCompanyId: number;
  chargesConfirmed: boolean;
  chargeEvidenceReference: string | null;
};

export type ConfirmContainerTradeImport = {
  sourceCompanyId: number;
  supplierId: number;
  fileSha256: string;
  fileMd5: string;
  fileName: string;
  importDate: string;
  actorUserId: string;
  actorUsername: string;
  selections: readonly ContainerTradeSelection[];
  containers: readonly ParsedContainerPreview[];
};

export type PreparedTrade = {
  container: ParsedContainerPreview;
  selection: ContainerTradeSelection;
  policy: IntercompanyRelationshipPolicy;
  goods: Decimal;
  discount: Decimal;
  positiveCharges: Decimal;
  confirmedCost: Decimal;
  sourcePoGroups: { number: string; lines: ParsedItemRow[]; split: PoChargeSplit }[];
};

export function verifyTradeSelections(
  previews: readonly ParsedContainerPreview[],
  choices: readonly ContainerTradeSelection[],
  policies: readonly IntercompanyRelationshipPolicy[]
): PreparedTrade[] {
  if (!previews.length || previews.length > 100) fail("The workbook must contain between 1 and 100 containers.");
  if (previews.length !== choices.length) fail("Select exactly one destination for every container.");
  const policyByDest = new Map(policies.filter((p) => p.tradeEnabled).map((p) => [p.destinationCompanyId, p]));
  const assigned = new Map<string, ContainerTradeSelection>();
  for (const choice of choices) {
    if (!choice.containerNumber?.trim() || assigned.has(choice.containerNumber.trim())) {
      fail("Every physical container must have exactly one destination assignment.");
    }
    if (!Number.isSafeInteger(choice.destinationCompanyId) || choice.destinationCompanyId < 1) {
      fail("Invalid destination company.");
    }
    if (typeof choice.chargesConfirmed !== "boolean") fail("Charges confirmation must be explicit.");
    assigned.set(choice.containerNumber.trim(), choice);
  }
  return previews.map((container) => {
    const selection = assigned.get(container.containerNumber);
    if (!selection) fail("Missing destination for container " + container.containerNumber);
    const policy = policyByDest.get(selection.destinationCompanyId);
    if (!policy) fail("Container destination has no enabled intercompany relationship: " + container.containerNumber, "INTERCOMPANY_PAIR_DISABLED", 409);
    if (policy.relationshipType !== "container_trade") fail("Company relationship is not a container trading relationship.");
    if (policy.baseCurrency !== "USD") fail("Phase 2 currently requires USD-valued posting accounts; non-USD configuration is held for FX support.", "INTERCOMPANY_CURRENCY_UNSUPPORTED");
    const configured = [
      policy.destinationSupplierId, policy.sourcePurchaseAccountId, policy.sourceSalesAccountId,
      policy.sourceCostAccountId, policy.sourceChargeAccrualAccountId, policy.destinationGitAccountId,
      policy.sourceReceivableAccountId, policy.destinationPayableAccountId,
    ];
    if (configured.some((v) => !v || v <= 0)) {
      fail("Configure verified receivable, payable, purchase, revenue, COGS, accrual, transit and destination supplier mappings for " + container.containerNumber, "INTERCOMPANY_MAPPING_MISSING", 409);
    }
    if (!container.containerNumber || container.containerNumber.length > 100) fail("Invalid container number.");
    if (!container.items.length || container.items.length > 3000) fail("Invalid item count in " + container.containerNumber);
    const groups = new Map<string, ParsedItemRow[]>();
    for (const item of container.items) {
      if (!item.poNumber.trim() || item.poNumber.length > 100) fail("Every original PO must have a valid number.");
      if (!item.barcode?.trim() || item.barcode.length > 50) fail("Every imported line requires a stock barcode for safe company mapping.");
      if (!item.itemName.trim()) fail("An imported line has no item name.");
      if (!Number.isFinite(item.quantity) || item.quantity <= 0 || new Decimal(item.quantity).decimalPlaces() > 3) {
        fail("Purchase quantity must be positive with at most three decimals: " + item.barcode);
      }
      if (!Number.isFinite(item.rate) || item.rate < 0 || new Decimal(item.rate).decimalPlaces() > 2) {
        fail("Purchase rate must be non-negative with at most two decimals: " + item.barcode);
      }
      if (item.currency.toUpperCase() !== "USD") {
        fail("Phase 2 imports only USD-denominated Excel lines; FX imports require the later accounting integration.", "INTERCOMPANY_CURRENCY_UNSUPPORTED");
      }
      if (!currency(new Decimal(item.quantity).times(item.rate)).eq(currency(item.lineTotal))) {
        fail("Excel line total differs from quantity × rate: " + item.barcode);
      }
      groups.set(item.poNumber, [...(groups.get(item.poNumber) ?? []), item]);
    }
    const moneyFields = ["freight", "surcharge", "fumigation", "documentCharges", "discount"] as const;
    for (const key of moneyFields) {
      const amount = container.charges[key];
      if (!Number.isFinite(amount) || amount < 0) fail("Invalid amount in " + key + " for " + container.containerNumber);
      if (new Decimal(amount).decimalPlaces() > 2) fail("Charge amounts must have at most two decimals.");
    }
    const evidence = selection.chargeEvidenceReference?.trim() ?? "";
    const amounts = container.charges;
    const hasCharges = moneyFields.some((key) => currency(amounts[key]).gt(0));
    if (selection.chargesConfirmed && hasCharges && evidence.length < 3) fail("Confirmed charges require an invoice/evidence reference.");
    if (!selection.chargesConfirmed && evidence) fail("Do not attach charge evidence until the charges are confirmed.");
    const goods = container.items.reduce((sum, row) => sum.plus(currency(row.lineTotal)), DECIMAL_ZERO);
    if (!goods.gt(0)) fail("Goods cost must be positive for " + container.containerNumber);
    const discount = selection.chargesConfirmed ? currency(amounts.discount) : DECIMAL_ZERO;
    const positiveCharges = selection.chargesConfirmed
      ? currency(amounts.freight).plus(currency(amounts.surcharge)).plus(currency(amounts.fumigation)).plus(currency(amounts.documentCharges))
      : DECIMAL_ZERO;
    if (discount.gt(goods)) fail("Supplier discount cannot exceed goods cost.");
    const confirmedCost = goods.minus(discount).plus(positiveCharges);
    if (!confirmedCost.gt(0)) fail("Confirmed landed cost must be positive.");
    const poNumbers = [...groups.keys()];
    const splits = allocatePoCharges(
      poNumbers.map((number) => groups.get(number)!.map((i) => currency(i.lineTotal).toFixed(2))),
      {
        freight: selection.chargesConfirmed ? amounts.freight : 0,
        surcharge: selection.chargesConfirmed ? amounts.surcharge : 0,
        fumigation: selection.chargesConfirmed ? amounts.fumigation : 0,
        documentCharges: selection.chargesConfirmed ? amounts.documentCharges : 0,
        discount: selection.chargesConfirmed ? amounts.discount : 0,
        otherCharges: 0,
      },
      false
    );
    const sourcePoGroups = poNumbers.map((number, index) => ({ number, lines: groups.get(number)!, split: splits[index] }));
    const splitTotal = sourcePoGroups.reduce((sum, group) => sum.plus(group.split.grandTotal), DECIMAL_ZERO);
    if (!splitTotal.eq(confirmedCost)) fail("Original purchase-order allocations do not match landed cost.");
    return { container, selection, policy, goods, discount, positiveCharges, confirmedCost, sourcePoGroups };
  });
}

function auditKey(fileSha: string, containerNumber: string): string {
  return "ic-import:" + createHash("sha256").update(fileSha + ":" + containerNumber).digest("hex");
}

async function activeCodeMap(tx: DbTransaction, companyId: number, codes: readonly string[]) {
  const list = await tx
    .select()
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), inArray(stockItems.code, [...new Set(codes)])));
  return new Map(list.filter((item) => item.active && !item.deletedAt).map((item) => [item.code, item]));
}

/**
 * Supplier POs are source-company purchase documents. Destination stock items
 * are verified against that destination. Source catalog items may be created at
 * zero opening stock, with the destination's known UOM; this creates NO stock.
 */
async function mapCatalogStockTx(
  tx: DbTransaction,
  sourceCompanyId: number,
  planned: readonly PreparedTrade[]
) {
  const sourceCodes = [...new Set(planned.flatMap((p) => p.container.items.map((row) => row.barcode!.trim())))];
  const source = await activeCodeMap(tx, sourceCompanyId, sourceCodes);
  const byDest = new Map<number, Map<string, typeof stockItems.$inferSelect>>();
  for (const destId of [...new Set(planned.map((p) => p.selection.destinationCompanyId))]) {
    const targetCodes = [...new Set(planned.filter((p) => p.selection.destinationCompanyId === destId).flatMap((p) => p.container.items.map((row) => row.barcode!.trim())))];
    byDest.set(destId, await activeCodeMap(tx, destId, targetCodes));
  }
  for (const plan of planned) {
    const destinationItems = byDest.get(plan.selection.destinationCompanyId)!;
    for (const line of plan.container.items) {
      const code = line.barcode!.trim();
      const targetItem = destinationItems.get(code);
      if (!targetItem) {
        fail("Item " + code + " does not exist in destination " + plan.selection.destinationCompanyId + ". Create or map the destination item first.", "INTERCOMPANY_DEST_ITEM_MISSING", 409);
      }
      if (!source.has(code)) {
        const [created] = await tx.insert(stockItems).values({
          companyId: sourceCompanyId,
          code,
          name: line.itemName,
          uom: targetItem.uom,
          openingQty: "0", openingRate: "0", openingValue: "0",
        }).returning();
        source.set(code, created);
      } else if (source.get(code)!.uom !== targetItem.uom) {
        fail("Source and destination item units differ for " + code + ". Review the item mapping first.", "INTERCOMPANY_ITEM_UOM_MISMATCH", 409);
      }
    }
  }
  return { source, byDest };
}

async function sourceSupplierTx(tx: DbTransaction, sourceCompanyId: number, supplierId: number) {
  const [supplier] = await tx.select().from(companyScopedSuppliers)
    .where(and(eq(companyScopedSuppliers.id, supplierId), eq(companyScopedSuppliers.companyId, sourceCompanyId)));
  if (!supplier || !supplier.active || supplier.deletedAt) fail("The external supplier is unavailable in Hassan Properties.", "INTERCOMPANY_SUPPLIER_INVALID", 409);
  return supplier;
}

async function writeContainerTx(
  tx: DbTransaction,
  input: ConfirmContainerTradeImport,
  plan: PreparedTrade,
  batchId: number,
  catalog: Awaited<ReturnType<typeof mapCatalogStockTx>>
) {
  const destId = plan.selection.destinationCompanyId;
  const policy = plan.policy;
  const number = plan.container.containerNumber;
  const amount = plan.confirmedCost.toFixed(2);
  const charges = plan.selection.chargesConfirmed ? plan.container.charges : { freight: 0, surcharge: 0, fumigation: 0, discount: 0, documentCharges: 0 };
  const [physical] = await tx.insert(containers).values({
    companyId: input.sourceCompanyId,
    containerNumber: number,
    supplierId: input.supplierId,
    importDate: input.importDate,
    status: "OTW",
    itemsTotal: plan.goods.toFixed(2),
    chargesTotal: plan.positiveCharges.minus(plan.discount).toFixed(2),
    grandTotal: amount,
  }).returning();
  const [trade] = await tx.insert(intercompanyTrades).values({
    relationshipId: policy.id,
    physicalContainerId: physical.id,
    sourceCompanyId: input.sourceCompanyId,
    destinationCompanyId: destId,
    state: "pending",
  }).returning();

  const sourcePoIds: number[] = [];
  for (const original of plan.sourcePoGroups) {
    const value = original.split;
    const goodsSupplierPayable = value.itemsTotal.minus(value.discount);
    const sourceCharges = value.freight.plus(value.surcharge).plus(value.fumigation).plus(value.documentCharges).plus(value.otherCharges);
    if (goodsSupplierPayable.isNegative()) fail("Discount cannot exceed an original source PO's goods total.");
    const rows: ErpVoucherLine[] = [];
    if (goodsSupplierPayable.gt(0)) rows.push(...pairLines(
      { ledgerAccountId: policy.sourcePurchaseAccountId! }, { supplierId: input.supplierId },
      goodsSupplierPayable.toFixed(2), "External goods purchase - " + original.number
    ));
    if (sourceCharges.gt(0)) rows.push(...pairLines(
      { ledgerAccountId: policy.sourcePurchaseAccountId! },
      { ledgerAccountId: policy.sourceChargeAccrualAccountId! },
      sourceCharges.toFixed(2), "Confirmed eligible landed charges - " + original.number
    ));
    if (!rows.length) fail("No valid supplier purchase postings for " + original.number);
    const voucher = await postErpVoucherTx(tx, {
      companyId: input.sourceCompanyId,
      voucherType: "Purchase",
      voucherDate: input.importDate,
      description: "External supplier " + original.number + " | " + number,
      sourceModule: "INTERCOMPANY_CONTAINER",
      source: { type: "ic-container-external-purchase", id: trade.id, revision: original.number },
      actor: { userId: input.actorUserId, username: input.actorUsername },
      lines: rows,
    });
    const [po] = await tx.insert(purchaseOrders).values({
      companyId: input.sourceCompanyId,
      containerId: physical.id,
      poNumber: original.number,
      supplierId: input.supplierId,
      voucherId: voucher.voucher.id,
      currency: "USD",
      itemsTotal: value.itemsTotal.toFixed(2),
      freight: value.freight.toFixed(2), surcharge: value.surcharge.toFixed(2),
      fumigation: value.fumigation.toFixed(2), documentCharges: value.documentCharges.toFixed(2),
      discount: value.discount.toFixed(2), otherCharges: "0",
      chargesEdited: plan.selection.chargesConfirmed, status: "Open",
    }).returning();
    sourcePoIds.push(po.id);
    await tx.insert(intercompanyTradeSourcePos).values({ tradeId: trade.id, sourcePoId: po.id, originalPoNumber: original.number });
    await tx.insert(poLineItems).values(original.lines.map((line) => ({
      poId: po.id,
      stockItemId: catalog.source.get(line.barcode!.trim())!.id,
      itemName: line.itemName,
      quantity: String(line.quantity),
      rate: currency(line.rate).toFixed(2),
      lineTotal: currency(line.lineTotal).toFixed(2),
    })));
  }

  // The source company's sale is exactly the verified cost, with no markup.
  const sale = await postErpVoucherTx(tx, {
    companyId: input.sourceCompanyId,
    voucherType: "Journal",
    voucherDate: input.importDate,
    description: "At-cost container transfer to destination " + destId + ": " + number,
    sourceModule: "INTERCOMPANY_CONTAINER",
    source: { type: "ic-container-source-sale", id: trade.id },
    actor: { userId: input.actorUserId, username: input.actorUsername },
    lines: [
      ...pairLines(
        { ledgerAccountId: policy.sourceReceivableAccountId! },
        { ledgerAccountId: policy.sourceSalesAccountId! }, amount, "At-cost intercompany resale"
      ),
      ...pairLines(
        { ledgerAccountId: policy.sourceCostAccountId! },
        { ledgerAccountId: policy.sourcePurchaseAccountId! }, amount, "Move purchased goods to intercompany COGS"
      ),
    ],
  });
  // GIT exists from the moment of confirmed import, not from offloading.
  const destVoucher = await postErpVoucherTx(tx, {
    companyId: destId,
    voucherType: "Purchase",
    voucherDate: input.importDate,
    description: "Goods in transit from Hassan Properties, " + number,
    sourceModule: "INTERCOMPANY_CONTAINER",
    source: { type: "ic-container-destination-git", id: trade.id },
    actor: { userId: input.actorUserId, username: input.actorUsername },
    lines: pairLines(
      { ledgerAccountId: policy.destinationGitAccountId! },
      { ledgerAccountId: policy.destinationPayableAccountId! },
      amount,
      "Confirmed at-cost internal purchase",
    ),
  });
  const [destPo] = await tx.insert(purchaseOrders).values({
    companyId: destId, containerId: physical.id,
    supplierId: policy.destinationSupplierId!,
    voucherId: destVoucher.voucher.id,
    poNumber: "IC-" + physical.id,
    currency: "USD",
    itemsTotal: plan.goods.toFixed(2),
    freight: currency(charges.freight).toFixed(2),
    surcharge: currency(charges.surcharge).toFixed(2),
    fumigation: currency(charges.fumigation).toFixed(2),
    documentCharges: currency(charges.documentCharges).toFixed(2),
    discount: currency(charges.discount).toFixed(2),
    otherCharges: "0",
    chargesEdited: plan.selection.chargesConfirmed,
  }).returning();
  await tx.insert(poLineItems).values(plan.container.items.map((line) => ({
    poId: destPo.id,
    stockItemId: catalog.byDest.get(destId)!.get(line.barcode!.trim())!.id,
    itemName: line.itemName,
    quantity: String(line.quantity),
    rate: currency(line.rate).toFixed(2),
    lineTotal: currency(line.lineTotal).toFixed(2),
  })));

  const [activated] = await tx.update(intercompanyTrades).set({
    originalSupplierPoId: sourcePoIds[0],
    destinationPoId: destPo.id,
    state: "active",
  }).where(eq(intercompanyTrades.id, trade.id)).returning();
  if (!activated) fail("Container trade could not be activated.", "INTERCOMPANY_ACTIVATION_FAILED", 409);

  if (plan.selection.chargesConfirmed) {
    const chargeRecords = [
      { chargeType: "Freight", value: currency(charges.freight) },
      { chargeType: "Surcharge", value: currency(charges.surcharge) },
      { chargeType: "Fumigation", value: currency(charges.fumigation) },
      { chargeType: "Document Charges", value: currency(charges.documentCharges) },
      { chargeType: "Discount", value: currency(charges.discount).neg() },
    ].filter((line) => !line.value.isZero());
    if (chargeRecords.length) await tx.insert(containerCharges).values(chargeRecords.map((rec) => ({
      containerId: physical.id, chargeType: rec.chargeType, amount: rec.value.toFixed(2),
    })));
  }

  await tx.insert(intercompanyImportBatchContainers).values({
    batchId,
    containerNumber: number,
    destinationCompanyId: destId,
    physicalContainerId: physical.id,
    tradeId: trade.id,
    chargesConfirmed: plan.selection.chargesConfirmed,
    chargeEvidenceReference: plan.selection.chargeEvidenceReference || null,
    confirmedLandedCost: amount,
  });
  await tx.insert(intercompanyAuditEvents).values({
    eventKey: auditKey(input.fileSha256, number),
    relationshipId: policy.id,
    sourceCompanyId: input.sourceCompanyId,
    actorUserId: input.actorUserId,
    eventType: "container_trade_import_confirmed",
    sourceReference: "import:" + batchId + ":" + number,
    payload: {
      tradeId: trade.id, containerId: physical.id, originalSupplierPoIds: sourcePoIds,
      destinationPoId: destPo.id, sourceSaleVoucherId: sale.voucher.id,
      destinationGitVoucherId: destVoucher.voucher.id,
      landedCost: amount, chargesConfirmed: plan.selection.chargesConfirmed,
      chargeEvidenceReference: plan.selection.chargeEvidenceReference,
    },
  });
  const [audit] = await tx.insert(intercompanyReconciliationRuns).values({
    relationshipId: policy.id, runKind: "immediate", state: "completed",
    cutoffDate: input.importDate, auditOnly: true, finishedAt: new Date(),
  }).returning();
  await tx.insert(intercompanyReconciliationFindings).values({
    runId: audit.id, relationshipId: policy.id,
    findingFingerprint: createHash("sha256").update("trade:" + trade.id).digest("hex"),
    evidenceFingerprint: createHash("sha256").update(amount + ":" + sale.voucher.id + ":" + destVoucher.voucher.id).digest("hex"),
    status: "matched", verified: true, differenceBaseAmount: "0",
    originalTransactionDate: input.importDate,
    evidence: { tradeId: trade.id, sourceReceivable: amount, destinationPayable: amount, sourceVoucherId: sale.voucher.id, destinationVoucherId: destVoucher.voucher.id },
  });
  return {
    tradeId: trade.id,
    physicalContainerId: physical.id,
    containerNumber: number,
    destinationCompanyId: destId,
    sourcePoIds,
    destinationPoId: destPo.id,
    landedCost: amount,
  };
}

/** The posted Excel file is re-parsed by the route; never trust a browser preview. */
export async function confirmContainerTradeImport(input: ConfirmContainerTradeImport) {
  if (!isIsoDate(input.importDate)) fail("Invalid import date.");
  if (!/^[a-f0-9]{64}$/.test(input.fileSha256) || !/^[a-f0-9]{32}$/.test(input.fileMd5)) fail("Invalid source file hash.");
  if (!Number.isSafeInteger(input.sourceCompanyId) || !Number.isSafeInteger(input.supplierId)) fail("Invalid source company or supplier.");
  if (!input.actorUserId) fail("Signed-in user required.");
  return db.transaction(async (tx) => {
    // One serializable source-company batch at a time, including catalog creation.
    await tx.execute(sql$SELECT pg_advisory_xact_lock(${IMPORT_LOCK_NAMESPACE}, ${input.sourceCompanyId})$);
    const [source] = await tx.select().from(companies).where(eq(companies.id, input.sourceCompanyId));
    if (!source || source.companyType !== "properties" || !source.active) fail("Intercompany container trading requires an active Properties source.");
    const existing = await tx.select({ id: intercompanyImportBatches.id }).from(intercompanyImportBatches)
      .where(and(eq(intercompanyImportBatches.sourceCompanyId, input.sourceCompanyId), eq(intercompanyImportBatches.fileSha256, input.fileSha256)));
    if (existing.length) fail("This Excel file was already imported to the Properties trading system.", "INTERCOMPANY_DUPLICATE_FILE", 409);
    const previousLegacy = await tx.select({ id: importLogs.id }).from(importLogs).where(eq(importLogs.fileHash, input.fileMd5));
    if (previousLegacy.length) fail("This source workbook has already been imported with the legacy ERP importer.", "INTERCOMPANY_DUPLICATE_FILE", 409);
    const policies = await tx.select().from(intercompanyRelationshipPolicies).where(
      and(eq(intercompanyRelationshipPolicies.sourceCompanyId, input.sourceCompanyId), eq(intercompanyRelationshipPolicies.relationshipType, "container_trade"))
    ).for("update");
    const planned = verifyTradeSelections(input.containers, input.selections, policies);
    const names = planned.map((p) => p.container.containerNumber);
    if (new Set(names).size !== names.length) fail("The workbook includes repeated physical container numbers.");
    const collisions = await tx.select({ number: containers.containerNumber }).from(containers).where(inArray(containers.containerNumber, names));
    if (collisions.length) fail("Physical container already exists: " + collisions.map((p) => p.number).join(", "), "INTERCOMPANY_CONTAINER_DUPLICATE", 409);
    await sourceSupplierTx(tx, input.sourceCompanyId, input.supplierId);
    const sourcePoNumbers = [...new Set(planned.flatMap((p) => p.sourcePoGroups.map((g) => g.number)))];
    const existingPos = await tx.select({ poNumber: purchaseOrders.poNumber }).from(purchaseOrders).where(
      and(eq(purchaseOrders.companyId, input.sourceCompanyId), inArray(purchaseOrders.poNumber, sourcePoNumbers))
    );
    if (existingPos.length) fail("An original external PO number already exists in this company.", "INTERCOMPANY_ORIGINAL_PO_DUPLICATE", 409);
    const catalog = await mapCatalogStockTx(tx, input.sourceCompanyId, planned);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      sourceCompanyId: input.sourceCompanyId,
      supplierId: input.supplierId,
      date: input.importDate,
      fileSha256: input.fileSha256,
      assignments: [...input.selections].sort((a,b) => a.containerNumber.localeCompare(b.containerNumber)),
    })).digest("hex");
    const [batch] = await tx.insert(intercompanyImportBatches).values({
      sourceCompanyId: input.sourceCompanyId,
      fileName: input.fileName.slice(0, 1000),
      fileSha256: input.fileSha256,
      requestFingerprint: fingerprint,
      state: "pending",
      createdBy: input.actorUserId,
    }).returning();
    const created = [];
    for (const plan of planned) created.push(await writeContainerTx(tx, input, plan, batch.id, catalog));
    await tx.update(intercompanyImportBatches).set({ state: "confirmed", confirmedAt: new Date() })
      .where(eq(intercompanyImportBatches.id, batch.id));
    return { batchId: batch.id, imported: created, numberOfContainers: created.length };
  });
}
