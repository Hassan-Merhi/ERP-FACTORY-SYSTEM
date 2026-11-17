/**
 * Exact, deterministic Phase 2 Excel container pricing plan.
 * The uploaded workbook is re-parsed server-side at confirmation. Never trust a
 * browser-calculated total or a file hash supplied by a client.
 */
import { toMoney, sumMoney } from "../../lib/money";
import { allocatePoCharges } from "../../routes/import/poChargeAllocation";
import type { ParsedContainerPreview } from "../../routes/import/poImportExcelParser";

export interface ConfirmedContainerSelection {
  containerNumber: string;
  relationshipId: number;
  chargesConfirmed: boolean;
  chargeEvidenceReference?: string;
}

export interface ImportLine {
  rowNum: number;
  barcode: string;
  itemName: string;
  quantity: string;
  rate: string;
  lineTotal: string;
  originalPoNumber: string;
}

export interface SourcePoPlan {
  originalPoNumber: string;
  lines: ImportLine[];
  itemsTotal: string;
  freight: string;
  surcharge: string;
  fumigation: string;
  documentCharges: string;
  discount: string;
  otherCharges: string;
  grandTotal: string;
  supplierCredit: string;
  chargeAccrualCredit: string;
}

export interface ContainerImportPlan {
  containerNumber: string;
  relationshipId: number;
  chargesConfirmed: boolean;
  chargeEvidenceReference: string | null;
  proposedCharges: ParsedContainerPreview["charges"];
  goodsTotal: string;
  chargesNet: string;
  landedTotal: string;
  sourcePos: SourcePoPlan[];
  lines: ImportLine[];
  charges: {
    freight: string;
    surcharge: string;
    fumigation: string;
    documentCharges: string;
    discount: string;
    otherCharges: string;
  };
}

const cents = (input: number | string) => toMoney(input).toDecimalPlaces(2);
const amount = (value: number | undefined, label: string) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(label + " must be a non-negative number");
  }
  const result = cents(value);
  if (result.gte("100000000000000000")) throw new Error(label + " is too large");
  return result;
};

export function createContainerImportPlan(
  container: ParsedContainerPreview,
  selection: ConfirmedContainerSelection
): ContainerImportPlan {
  const name = container.containerNumber.trim();
  if (!name || name.length > 100 || name !== selection.containerNumber.trim()) {
    throw new Error("Container number and selected destination must match the uploaded workbook");
  }
  if (!Number.isSafeInteger(selection.relationshipId) || selection.relationshipId <= 0) {
    throw new Error(name + ": select a valid destination company");
  }
  if (!container.items.length || container.items.length > 2000) {
    throw new Error(name + ": container must contain between 1 and 2,000 purchase lines");
  }
  const groups = new Map<string, ImportLine[]>();
  for (const item of container.items) {
    const quantity = toMoney(item.quantity);
    const rate = toMoney(item.rate);
    const computedLine = quantity.times(rate).toDecimalPlaces(2);
    const workbookLine = cents(item.lineTotal);
    if (
      !Number.isFinite(item.quantity) ||
      !Number.isFinite(item.rate) ||
      !Number.isFinite(item.lineTotal) ||
      quantity.lte(0) ||
      quantity.decimalPlaces() > 3 ||
      rate.lt(0) ||
      rate.decimalPlaces() > 2 ||
      !computedLine.eq(workbookLine) ||
      computedLine.lt(0)
    ) {
      throw new Error(name + ": invalid quantity, rate or extended price on Excel row " + item.rowNum);
    }
    if (item.currency.toUpperCase() !== "USD") {
      throw new Error(name + ": Phase 2 accepts USD invoices only; foreign-currency imports need the FX phase");
    }
    const originalPoNumber = item.poNumber.trim();
    if (originalPoNumber.length > 100) {
      throw new Error(name + ": original PO number on row " + item.rowNum + " is too long");
    }
    const line: ImportLine = {
      rowNum: item.rowNum,
      barcode: item.barcode?.trim() ?? "",
      itemName: item.itemName.trim(),
      quantity: quantity.toFixed(3),
      rate: rate.toFixed(2),
      lineTotal: computedLine.toFixed(2),
      originalPoNumber,
    };
    if (!line.barcode && !line.itemName) throw new Error(name + ": missing item identity on row " + item.rowNum);
    const key = originalPoNumber;
    const current = groups.get(key) ?? [];
    current.push(line);
    groups.set(key, current);
  }

  const goods = sumMoney([...groups.values()].flatMap((items) => items.map((line) => line.lineTotal)));
  if (goods.lte(0) || !goods.eq(cents(container.itemsTotal))) {
    throw new Error(name + ": Excel item totals do not reconcile exactly to the cent");
  }

  const proposed = container.charges;
  const freight = amount(proposed.freight, "Freight");
  const surcharge = amount(proposed.surcharge, "Surcharge");
  const fumigation = amount(proposed.fumigation, "Fumigation");
  const documentCharges = amount(proposed.documentCharges, "Document charges");
  const discount = amount(proposed.discount, "Discount");
  if (discount.gt(goods)) throw new Error(name + ": discount exceeds goods value");

  const proposalNet = freight.plus(surcharge).plus(fumigation).plus(documentCharges).minus(discount);
  if (!proposalNet.eq(cents(container.chargesTotal)) || !goods.plus(proposalNet).eq(cents(container.grandTotal))) {
    throw new Error(name + ": Excel grand total and charges do not reconcile");
  }
  // The uploaded PO is authoritative: its validated charges must always be
  // included. A UI confirmation checkbox cannot silently discard PO charges.
  // An optional invoice reference remains available for audit evidence.
  const chosenEvidence = selection.chargeEvidenceReference?.trim() || null;
  const hasProposedCharges = !freight.plus(surcharge).plus(fumigation).plus(documentCharges).plus(discount).isZero();
  if (chosenEvidence && chosenEvidence.length > 250) {
    throw new Error(name + ": charge evidence reference is too long");
  }

  const charges = {
    freight: freight.toFixed(2),
    surcharge: surcharge.toFixed(2),
    fumigation: fumigation.toFixed(2),
    documentCharges: documentCharges.toFixed(2),
    discount: discount.toFixed(2),
    otherCharges: "0.00",
  };
  const groupList = [...groups.entries()];
  const splits = allocatePoCharges(
    groupList.map(([, lines]) => lines.map((line) => line.lineTotal)),
    charges,
    false
  );
  const sourcePos: SourcePoPlan[] = groupList.map(([key, lines], i) => {
    const split = splits[i];
    // The selected external supplier owns the complete imported landed cost by
    // default. Freight and other PO charges are not a separate payable unless
    // a dedicated creditor was explicitly selected (not supported by this flow).
    const supplierCredit = split.grandTotal;
    const chargeAccrualCredit = cents(0);
    if (supplierCredit.lt(0) || split.grandTotal.lte(0)) {
      throw new Error(name + ": invoice discount leaves an invalid external payable");
    }
    if (!supplierCredit.plus(chargeAccrualCredit).eq(split.grandTotal)) {
      throw new Error(name + ": source PO is not balanced");
    }
    return {
      originalPoNumber: key,
      lines,
      itemsTotal: split.itemsTotal.toFixed(2),
      freight: split.freight.toFixed(2),
      surcharge: split.surcharge.toFixed(2),
      fumigation: split.fumigation.toFixed(2),
      documentCharges: split.documentCharges.toFixed(2),
      discount: split.discount.toFixed(2),
      otherCharges: split.otherCharges.toFixed(2),
      grandTotal: split.grandTotal.toFixed(2),
      supplierCredit: supplierCredit.toFixed(2),
      chargeAccrualCredit: chargeAccrualCredit.toFixed(2),
    };
  });
  const chargesNet = proposalNet;
  const landed = goods.plus(chargesNet);
  if (landed.lte(0) || !sumMoney(sourcePos.map((p) => p.grandTotal)).eq(landed)) {
    throw new Error(name + ": confirmed landed cost does not reconcile");
  }
  return {
    containerNumber: name,
    relationshipId: selection.relationshipId,
    chargesConfirmed: hasProposedCharges,
    chargeEvidenceReference: hasProposedCharges ? chosenEvidence : null,
    proposedCharges: proposed,
    goodsTotal: goods.toFixed(2),
    chargesNet: chargesNet.toFixed(2),
    landedTotal: landed.toFixed(2),
    sourcePos,
    lines: groupList.flatMap(([, lines]) => lines),
    charges,
  };
}
