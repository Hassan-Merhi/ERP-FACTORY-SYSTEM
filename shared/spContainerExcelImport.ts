/**
 * Supplier Partner container import from the ERP "PO Import" Excel.
 *
 * A Supplier Partner receives the same container spreadsheet every ERP company
 * imports (Container_Number, PO_Number, Supplier_Code, Item_Barcode, Item_Name,
 * Quantity, Rate, Freight, Surcharge, Fumigation, Discount, Document_Charges,
 * or the equivalent Charge_Type / Charge_Amount rows). The ERP side turns that
 * file into purchase orders and a Purchases voucher. The Supplier Partner side
 * keeps a different model — one SP container with an invoice total, a uniform
 * discount percentage, the supplier-invoice charges (freight, surcharge,
 * fumigation, document charges) and article lines — and posts
 * Dr Goods OTW / Cr Goods OTW Clearing for the invoice total. At offload the
 * invoice charges become landed cost automatically (shared/spContainerInvoiceCharges.ts).
 *
 * This module is the calculation between the two: it takes one parsed container
 * of the ERP sheet and derives every Supplier Partner figure from it, so the
 * import dialog can be filled from the file and the user only reviews. It is
 * pure and shared so the server (which runs it) and the client (which types
 * against it) agree on the shape.
 */

export interface SpExcelSourceLine {
  poNumber: string;
  barcode: string | null;
  stockItemId: number | null;
  itemName: string;
  quantity: number;
  rate: number;
  lineTotal: number;
}

export interface SpExcelSourceCharges {
  freight: number;
  surcharge: number;
  fumigation: number;
  discount: number;
  documentCharges: number;
}

/** One container as the shared PO-import sheet parser yields it. */
export interface SpExcelSourceContainer {
  containerNumber: string;
  supplierCode: string;
  itemsTotal: number;
  charges: SpExcelSourceCharges;
  chargesTotal: number;
  grandTotal: number;
  items: SpExcelSourceLine[];
  pos: string[];
}

export interface SpExcelSupplierOption {
  id: number;
  legalName: string;
  code: string;
}

export interface SpExcelImportLine {
  /** Barcode from the sheet, or the item name when the sheet carried no barcode. */
  articleCode: string;
  /** Resolved stock item name when the code matched, else the sheet's item name. */
  description: string;
  qty: number;
  unitRateUsd: number;
  /** qty × rate before the container discount, as the sheet states it. */
  lineTotal: number;
  stockItemId: number | null;
  poNumber: string;
}

export interface SpExcelImportContainer {
  containerNumber: string;
  supplierCode: string;
  /** Supplier whose code matched the sheet's Supplier_Code, if any. */
  supplierId: number | null;
  supplierName: string;
  poNumbers: string[];
  itemsCount: number;
  /** Σ qty × rate, before any charge or discount. */
  itemsTotal: number;
  charges: SpExcelSourceCharges;
  /** freight + surcharge + fumigation + document charges − discount. */
  chargesTotal: number;
  /** itemsTotal + chargesTotal: what the ERP posts for the container. */
  grandTotal: number;
  /**
   * The sheet's discount as a percentage of itemsTotal, which is how the SP
   * model applies a discount (uniformly to every line). 0 when there is none.
   */
  discountPct: number;
  /** Supplier-invoice charges kept on the SP container and added to landed cost at offload. */
  freightEstimateUsd: number;
  surchargeUsd: number;
  fumigationUsd: number;
  documentChargesUsd: number;
  /** Goods OTW amount: the same grand total the ERP would post for this file. */
  invoiceTotalUsd: number;
  /** First PO number, else the container number — the user can still edit it. */
  suggestedInvoiceNumber: string;
  /** Source file, PO numbers and the discount conversion, kept on the container notes. */
  notes: string;
  /** Article codes that matched no stock item or alias in this company. */
  unmatchedArticleCodes: string[];
  lines: SpExcelImportLine[];
}

export const SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH = "/api/sp/containers/import-excel/parse";

export function roundMoney(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatUsd(value: number): string {
  return `$${roundMoney(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function normalizeCode(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

export function matchSupplierByCode(
  supplierCode: string,
  suppliers: readonly SpExcelSupplierOption[]
): SpExcelSupplierOption | null {
  const wanted = normalizeCode(supplierCode);
  if (!wanted) return null;
  return suppliers.find((supplier) => normalizeCode(supplier.code) === wanted) ?? null;
}

/**
 * Derives the Supplier Partner container from one parsed ERP sheet container.
 *
 * Totals are the ERP's own (itemsTotal, chargesTotal, grandTotal), so the Goods
 * OTW voucher the SP posts equals what the ERP would post for the same file.
 * The discount percentage is stored to 4 decimals (the column's scale); the
 * cents it may miss on the SP base cost do not affect the OTW voucher, which is
 * posted for the exact grand total.
 */
export function buildSpContainerExcelImport(
  source: SpExcelSourceContainer,
  suppliers: readonly SpExcelSupplierOption[]
): SpExcelImportContainer {
  const supplier = matchSupplierByCode(source.supplierCode, suppliers);
  const charges: SpExcelSourceCharges = {
    freight: roundMoney(source.charges.freight || 0),
    surcharge: roundMoney(source.charges.surcharge || 0),
    fumigation: roundMoney(source.charges.fumigation || 0),
    discount: roundMoney(source.charges.discount || 0),
    documentCharges: roundMoney(source.charges.documentCharges || 0),
  };

  const itemsTotal = roundMoney(source.itemsTotal);
  const chargesTotal = roundMoney(source.chargesTotal);
  const grandTotal = roundMoney(source.grandTotal);
  const discountPct = charges.discount > 0 && itemsTotal > 0 ? roundMoney((charges.discount / itemsTotal) * 100, 4) : 0;

  const lines: SpExcelImportLine[] = source.items.map((item) => ({
    articleCode: (item.barcode ?? "").trim() || item.itemName.trim(),
    description: item.itemName.trim(),
    qty: item.quantity,
    unitRateUsd: item.rate,
    lineTotal: roundMoney(item.lineTotal),
    stockItemId: item.stockItemId ?? null,
    poNumber: item.poNumber,
  }));

  const unmatchedArticleCodes = Array.from(
    new Set(lines.filter((line) => line.stockItemId === null).map((line) => line.articleCode))
  );

  const poNumbers = source.pos.filter((po) => po.trim() !== "");
  const noteParts: string[] = [`Imported from PO Import Excel (container ${source.containerNumber || "n/a"})`];
  if (poNumbers.length > 0) noteParts.push(`PO ${poNumbers.join(", ")}`);
  if (charges.discount > 0) noteParts.push(`Discount ${formatUsd(charges.discount)} (${discountPct}% of items)`);

  return {
    containerNumber: source.containerNumber,
    supplierCode: source.supplierCode,
    supplierId: supplier?.id ?? null,
    supplierName: supplier?.legalName ?? "",
    poNumbers,
    itemsCount: source.items.length,
    itemsTotal,
    charges,
    chargesTotal,
    grandTotal,
    discountPct,
    freightEstimateUsd: charges.freight,
    surchargeUsd: charges.surcharge,
    fumigationUsd: charges.fumigation,
    documentChargesUsd: charges.documentCharges,
    invoiceTotalUsd: grandTotal,
    suggestedInvoiceNumber: poNumbers[0] ?? source.containerNumber,
    notes: noteParts.join(" · "),
    unmatchedArticleCodes,
    lines,
  };
}
