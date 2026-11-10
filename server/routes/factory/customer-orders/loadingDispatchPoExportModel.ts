/**
 * Phase 5: factory finalized-trip -> existing ERP PO Import Excel contract.
 *
 * Exporting the PO file is NOT an ERP import or a supplier payable posting.
 * Frozen Factory sale prices are never silently reused as ERP purchase costs:
 * every grouped article needs an explicitly reviewed ERP purchase rate.
 */
import { createHash } from "node:crypto";
import { MoneyDecimal, sumMoney } from "../../../lib/money";

export const TRIP_PO_HEADERS = [
  "PO_Number", "Container_Number", "Supplier_Code", "Item_Barcode", "Item_Name",
  "Quantity", "Rate", "Currency", "Freight", "Surcharge", "Fumigation",
  "Discount", "Document_Charges",
] as const;

export const TRIP_PO_CHARGE_KEYS = [
  "freight", "surcharge", "fumigation", "discount", "documentCharges",
] as const;

export type PoChargeKey = (typeof TRIP_PO_CHARGE_KEYS)[number];
export type ErpPoCharges = Record<PoChargeKey, string>;

export interface FrozenTripPoBale {
  baleId: number;
  articleCode: string;
  productName: string;
  weightKg: string;
  lineTotal: string;
}
export interface FrozenTripPoCharge {
  id: number;
  name: string;
  kind: "BILLABLE" | "DISCOUNT" | "INTERNAL";
  amount: string;
  currency: string;
  erpChargeType: "freight" | "surcharge" | "fumigation" | "documentCharges" | null;
}
export interface PostedTripPoSource {
  companyId: number;
  orderId: number;
  dispatchId: number;
  financialId: number;
  revision: number;
  status: "POSTED" | "CONSOLIDATED";
  sourceFingerprint: string;
  currency: string;
  goodsSubtotal: string;
  billableChargesTotal: string;
  discountTotal: string;
  customerTotal: string;
  bales: FrozenTripPoBale[];
  charges: FrozenTripPoCharge[];
}
export interface TripPoArticle {
  articleCode: string;
  itemName: string;
  quantity: number;
  totalKg: string;
  factoryGoodsValue: string;
  distinctFactoryNames: string[];
}
export interface TripPoExportChoice {
  supplierCode: string;
  rates: Array<{ articleCode: string; rate: string }>;
  charges: ErpPoCharges;
}
export type ErpPoImportRow = {
  PO_Number: string;
  Container_Number: string;
  Supplier_Code: string;
  Item_Barcode: string;
  Item_Name: string;
  Quantity: number;
  Rate: number;
  Currency: "USD";
  Freight: number;
  Surcharge: number;
  Fumigation: number;
  Discount: number;
  Document_Charges: number;
};
export interface TripPoExportResult {
  poNumber: string;
  containerNumber: string;
  supplierCode: string;
  sourceFingerprint: string;
  exportFingerprint: string;
  revision: number;
  articles: TripPoArticle[];
  rates: Array<{ articleCode: string; rate: string }>;
  charges: ErpPoCharges;
  frozenFactoryCustomerTotal: string;
  erpGoodsTotal: string;
  erpChargesTotal: string;
  erpSupplierInvoiceTotal: string;
  rows: ErpPoImportRow[];
}
export class TripPoExportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "TripPoExportError";
  }
}
function refuse(code: string, message: string, status = 409): never {
  throw new TripPoExportError(code, message, status);
}
const ZERO = new MoneyDecimal(0);
const cents = (text: string, label: string, allowZero = true): string => {
  if (typeof text !== "string" || !/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,2})?$/.test(text.trim())) {
    refuse("PO_AMOUNT_INVALID", `${label} needs a nonnegative USD amount with up to two decimals`, 400);
  }
  const amount = new MoneyDecimal(text.trim());
  if (!amount.isFinite() || amount.isNegative() || (!allowZero && amount.isZero())) {
    refuse("PO_AMOUNT_INVALID", `${label} must be ${allowZero ? "nonnegative" : "greater than zero"}`, 400);
  }
  return amount.toFixed(2);
};
function decimalKg(text: string): string {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/.test(String(text))) {
    refuse("PO_SOURCE_INVALID", "Frozen bale has invalid KG");
  }
  return new MoneyDecimal(text).toFixed(3);
}
export function normalizePoArticleCode(raw: string): string {
  const code = String(raw ?? "").trim().toUpperCase();
  if (!code || code.length > 50 || /^[=+@-]/.test(code) || /[\u0000-\u001f\u007f]/.test(code)) {
    refuse("PO_ARTICLE_INVALID", "A frozen bale has an invalid or spreadsheet-unsafe article code");
  }
  return code;
}
function safeSupplierCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code || code.length > 100 || /^[=+@-]/.test(code) ||
      /[\u0000-\u001f\u007f]/.test(code)) {
    refuse("PO_SUPPLIER_CODE_INVALID", "Enter a valid ERP supplier code before exporting", 400);
  }
  return code;
}
/** The same trip has one stable ERP container identity on every download. */
export function tripErpContainerNumber(companyId: number, orderId: number, dispatchId: number): string {
  return `FD-${companyId}-${orderId}-${dispatchId}`;
}
export function tripErpPoNumber(companyId: number, orderId: number, dispatchId: number): string {
  return `FDPO-${companyId}-${orderId}-${dispatchId}`;
}
function exactMoney(value: string, name: string) {
  return new MoneyDecimal(cents(value, name));
}
function keepText(value: unknown): string {
  const text = String(value ?? "").trim();
  // Excel sheet-to-JSON returns the text verbatim. Never let a spreadsheet
  // formula-like name become an Excel formula when generating a workbook.
  if (!text) return "Unnamed Factory Article";
  const dangerous = /^[\s\u0000-\u0020]*[=+@-]/.test(text) || /[\r\n\t]/.test(text);
  return dangerous ? "'" + text : text;
}
export function groupFrozenTripArticles(source: PostedTripPoSource): TripPoArticle[] {
  if (!source.bales.length) refuse("PO_NO_SIGNED_BALES", "There are no frozen financially posted bales for this truck");
  if (!Number.isSafeInteger(source.companyId) || source.companyId < 1 ||
      !Number.isSafeInteger(source.orderId) || source.orderId < 1 ||
      !Number.isSafeInteger(source.dispatchId) || source.dispatchId < 1 ||
      !Number.isSafeInteger(source.financialId) || source.financialId < 1 ||
      !Number.isSafeInteger(source.revision) || source.revision < 1) {
    refuse("PO_SOURCE_INVALID", "Invalid signed Factory company/order/trip/revision identity");
  }
  if (!/^[0-9a-f]{64}$/.test(source.sourceFingerprint) ||
      !["POSTED", "CONSOLIDATED"].includes(source.status) || source.currency !== "USD") {
    refuse("PO_SOURCE_INVALID", "This is not a posted USD Factory financial trip");
  }
  const group = new Map<string, {
    names: Set<string>; quantity: number; kg: InstanceType<typeof MoneyDecimal>;
    goods: InstanceType<typeof MoneyDecimal>;
  }>();
  const seen = new Set<number>();
  for (const bale of source.bales) {
    if (!Number.isSafeInteger(bale.baleId) || bale.baleId < 1 || seen.has(bale.baleId)) {
      refuse("PO_DUPLICATE_BALE", "Frozen trip contains a duplicate or invalid bale ID");
    }
    seen.add(bale.baleId);
    const articleCode = normalizePoArticleCode(bale.articleCode);
    const amount = exactMoney(bale.lineTotal, "Bale amount");
    const kg = new MoneyDecimal(decimalKg(bale.weightKg));
    const value = group.get(articleCode) ?? { names: new Set<string>(), quantity: 0, kg: new MoneyDecimal(0), goods: new MoneyDecimal(0) };
    value.quantity += 1;
    if (!Number.isSafeInteger(value.quantity)) refuse("PO_QUANTITY_OVERFLOW", "Article quantity exceeds Excel's safe integer limit");
    value.kg = value.kg.plus(kg);
    value.goods = value.goods.plus(amount);
    value.names.add(keepText(bale.productName));
    group.set(articleCode, value);
  }
  const actualGoods = sumMoney(source.bales.map(b => cents(b.lineTotal, "Bale value")));
  if (!actualGoods.eq(exactMoney(source.goodsSubtotal, "Factory signed goods subtotal"))) {
    refuse("PO_FINANCIAL_SOURCE_MISMATCH", "Frozen bale amounts do not match the posted Factory goods total");
  }
  return [...group.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([articleCode, data]) => ({
    articleCode, itemName: [...data.names].sort()[0],
    quantity: data.quantity, totalKg: data.kg.toFixed(3), factoryGoodsValue: data.goods.toFixed(2),
    distinctFactoryNames: [...data.names].sort(),
  }));
}
export function suggestedErpPoCharges(source: PostedTripPoSource): {
  charges: ErpPoCharges; unmappedBillableCharges: Array<{ id: number; name: string; amount: string }>;
  internalExpenseTotal: string;
} {
  const value: ErpPoCharges = {
    freight: "0.00", surcharge: "0.00", fumigation: "0.00",
    discount: "0.00", documentCharges: "0.00",
  };
  const amounts = new Map<PoChargeKey, InstanceType<typeof MoneyDecimal>>();
  for (const key of TRIP_PO_CHARGE_KEYS) amounts.set(key, new MoneyDecimal(0));
  const unmappedBillableCharges: Array<{ id: number; name: string; amount: string }> = [];
  const seen = new Set<number>();
  for (const charge of source.charges) {
    if (seen.has(charge.id) || !Number.isSafeInteger(charge.id) || charge.id < 1 || charge.currency !== "USD") {
      refuse("PO_CHARGES_INVALID", "Frozen trip charges are not unique USD records");
    }
    seen.add(charge.id);
    const amount = exactMoney(charge.amount, "Factory charge amount");
    const key: PoChargeKey | null =
      charge.kind === "DISCOUNT" ? "discount" :
      charge.kind === "BILLABLE" && charge.erpChargeType ? charge.erpChargeType : null;
    if (key) {
      if (!(TRIP_PO_CHARGE_KEYS as readonly string[]).includes(key)) {
        refuse("PO_CHARGE_UNSUPPORTED", "Unsupported ERP PO charge type on a finalized Factory trip");
      }
      amounts.set(key, amounts.get(key)!.plus(amount));
    } else if (charge.kind === "BILLABLE") {
      unmappedBillableCharges.push({ id: charge.id, name: charge.name, amount: amount.toFixed(2) });
    } else if (charge.kind !== "INTERNAL") {
      refuse("PO_CHARGE_UNSUPPORTED", "Unknown Factory charge classification");
    }
  }
  for (const key of TRIP_PO_CHARGE_KEYS) value[key] = amounts.get(key)!.toFixed(2);
  const internalExpenseTotal = sumMoney(source.charges
    .filter(c => c.kind === "INTERNAL").map(c => c.amount)).toFixed(2);
  const summedBillable = sumMoney(source.charges
    .filter(c => c.kind === "BILLABLE").map(c => c.amount));
  const summedDiscount = sumMoney(source.charges
    .filter(c => c.kind === "DISCOUNT").map(c => c.amount));
  const computedCustomerTotal = exactMoney(source.goodsSubtotal, "Factory goods")
    .plus(summedBillable).minus(summedDiscount);
  if (!summedBillable.eq(exactMoney(source.billableChargesTotal, "Factory billable charges")) ||
      !summedDiscount.eq(exactMoney(source.discountTotal, "Factory discount")) ||
      !computedCustomerTotal.eq(exactMoney(source.customerTotal, "Factory customer total"))) {
    refuse("PO_FINANCIAL_SOURCE_MISMATCH", "Frozen charges do not reconcile with the posted Factory customer total");
  }
  return { charges: value, unmappedBillableCharges, internalExpenseTotal };
}
export function buildTripPoExport(source: PostedTripPoSource, choice: TripPoExportChoice): TripPoExportResult {
  const articles = groupFrozenTripArticles(source);
  // Always validate all signed charge values even when ERP imports have
  // separately chosen their own charge amounts.
  suggestedErpPoCharges(source);
  const supplierCode = safeSupplierCode(choice.supplierCode);
  if (!Array.isArray(choice.rates) || choice.rates.length !== articles.length) {
    refuse("PO_RATE_REVIEW_REQUIRED", "Enter and review a separate ERP purchase rate for every article", 400);
  }
  const rateMap = new Map<string,string>();
  for (const raw of choice.rates) {
    if (!raw || typeof raw.articleCode !== "string") refuse("PO_RATE_INVALID", "Article purchase rate is invalid", 400);
    const article = normalizePoArticleCode(raw.articleCode);
    if (rateMap.has(article)) refuse("PO_RATE_DUPLICATE", "ERP purchase rate supplied more than once for the same article", 400);
    rateMap.set(article, cents(raw.rate, "ERP rate for " + article, false));
  }
  for (const article of articles) {
    if (!rateMap.has(article.articleCode)) refuse("PO_RATE_MISSING", "ERP rate missing for " + article.articleCode, 400);
  }
  if (!choice.charges || typeof choice.charges !== "object" || Array.isArray(choice.charges)) {
    refuse("PO_CHARGES_REVIEW_REQUIRED", "Review the ERP supplier invoice charges", 400);
  }
  const charges = {} as ErpPoCharges;
  for (const key of TRIP_PO_CHARGE_KEYS) charges[key] = cents(choice.charges[key], "ERP " + key + " charge");
  const goods = sumMoney(articles.map(a => new MoneyDecimal(rateMap.get(a.articleCode)!).times(a.quantity)));
  const chargeTotal = new MoneyDecimal(charges.freight).plus(charges.surcharge)
    .plus(charges.fumigation).plus(charges.documentCharges).minus(charges.discount);
  const payable = goods.plus(chargeTotal);
  if (payable.lte(0)) refuse("PO_SUPPLIER_TOTAL_INVALID", "ERP supplier total must be greater than zero", 400);

  const containerNumber = tripErpContainerNumber(source.companyId, source.orderId, source.dispatchId);
  const poNumber = tripErpPoNumber(source.companyId, source.orderId, source.dispatchId);
  const rows: ErpPoImportRow[] = articles.map((item, index) => ({
    PO_Number: poNumber, Container_Number: containerNumber,
    Supplier_Code: supplierCode, Item_Barcode: item.articleCode,
    Item_Name: item.itemName, Quantity: item.quantity,
    Rate: Number(rateMap.get(item.articleCode)!), Currency: "USD",
    Freight: index === 0 ? Number(charges.freight) : 0,
    Surcharge: index === 0 ? Number(charges.surcharge) : 0,
    Fumigation: index === 0 ? Number(charges.fumigation) : 0,
    Discount: index === 0 ? Number(charges.discount) : 0,
    Document_Charges: index === 0 ? Number(charges.documentCharges) : 0,
  }));
  const rates = articles.map(a => ({ articleCode: a.articleCode, rate: rateMap.get(a.articleCode)! }));
  const fingerprintInput = {
    format: "ERP-PO-IMPORT-v1", version: 1,
    companyId: source.companyId, orderId: source.orderId,
    dispatchId: source.dispatchId, financialId: source.financialId,
    revision: source.revision, sourceFingerprint: source.sourceFingerprint,
    supplierCode, poNumber, containerNumber, rates, charges,
    goodsTotal: goods.toFixed(2), payable: payable.toFixed(2),
  };
  return {
    poNumber, containerNumber, supplierCode, sourceFingerprint: source.sourceFingerprint,
    exportFingerprint: createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex"),
    revision: source.revision, articles, rates, charges,
    frozenFactoryCustomerTotal: source.customerTotal,
    erpGoodsTotal: goods.toFixed(2), erpChargesTotal: chargeTotal.toFixed(2),
    erpSupplierInvoiceTotal: payable.toFixed(2), rows,
  };
}
