/**
 * Phase 6: Strict, opt-in validation for Factory Dispatch-generated PO files.
 *
 * Ordinary ERP PO imports retain their existing behavior. A canonical
 * FD-n-n-n container must have its matching FDPO-n-n-n number and an exact
 * ERP stock code/alias. Never resolve a Factory article by product name.
 */
import { MoneyDecimal, sumMoney } from "../../lib/money";
import type Decimal from "decimal.js";
import { storage } from "../../storage";
import type { StockItem, Supplier } from "@shared/schema";
import type { PoImportPreviewContainer, PoImportPreviewItem } from "./po-import-preview";

export interface FactoryTripPoIdentity {
  factoryCompanyId: number;
  factoryOrderId: number;
  factoryDispatchId: number;
  containerNumber: string;
  poNumber: string;
}
export interface FactoryTripPoValidation {
  identity: FactoryTripPoIdentity | null;
  errors: string[];
  resolvedItems: Array<{ index: number; stockItemId: number; itemName: string }>;
  goodsTotal: string | null;
  supplierTotal: string | null;
}
const CANONICAL = /^FD-([1-9]\d*)-([1-9]\d*)-([1-9]\d*)$/;
const RESERVED = /^(FD-|FDPO-)/i;
const MONEY = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/;
function validInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function parseFactoryTripPoIdentity(
  containerNumber: string,
  poNumbers: readonly string[]
): { identity: FactoryTripPoIdentity | null; errors: string[] } {
  const errors: string[] = [];
  const number = String(containerNumber ?? "").trim();
  const pos = poNumbers.map((p) => String(p ?? "").trim());
  const relevant = RESERVED.test(number) || pos.some((p) => RESERVED.test(p));
  if (!relevant) return { identity: null, errors };
  const match = CANONICAL.exec(number);
  if (!match) {
    return {
      identity: null,
      errors: ["Factory dispatch PO import requires the original FD-company-order-trip container number."],
    };
  }
  const parts = match.slice(1).map(validInt);
  if (parts.some((p) => p == null)) {
    return { identity: null, errors: ["Factory dispatch PO contains unsafe or invalid numerical identifiers."] };
  }
  const [factoryCompanyId, factoryOrderId, factoryDispatchId] = parts as number[];
  const canonicalContainer = `FD-${factoryCompanyId}-${factoryOrderId}-${factoryDispatchId}`;
  const expectedPo = `FDPO-${factoryCompanyId}-${factoryOrderId}-${factoryDispatchId}`;
  if (number !== canonicalContainer || pos.length === 0 || pos.some((p) => p !== expectedPo)) {
    errors.push(
      `Factory dispatch PO number must be ${expectedPo}, with container ${canonicalContainer}. Do not rename either identity.`
    );
  }
  return {
    identity: {
      factoryCompanyId,
      factoryOrderId,
      factoryDispatchId,
      containerNumber: canonicalContainer,
      poNumber: expectedPo,
    },
    errors,
  };
}
function numericMoney(input: unknown): Decimal | null {
  if ((typeof input !== "number" && typeof input !== "string") || !MONEY.test(String(input).trim())) return null;
  const value = new MoneyDecimal(String(input).trim());
  return value.isFinite() && value.gte(0) ? value : null;
}
/** The legacy PO parser stores calculated spreadsheet totals as JS numbers. */
function roundedSourceAmount(raw: unknown, allowNegative = false): Decimal | null {
  if ((typeof raw !== "number" && typeof raw !== "string") || !Number.isFinite(Number(raw))) return null;
  const value = new MoneyDecimal(String(raw));
  const rounded = value.toDecimalPlaces(2);
  // Only absorb IEEE-754 addition/multiplication noise, not genuine
  // three-decimal charges or a negative line/invoice charge.
  if (!allowNegative && rounded.isNegative()) return null;
  return value.minus(rounded).abs().lte("0.0000001") ? rounded : null;
}
function nonNegativeQuantity(item: PoImportPreviewItem): boolean {
  return Number.isSafeInteger(item.quantity) && item.quantity > 0;
}
export async function validateFactoryDispatchPoImport(
  companyId: number,
  container: PoImportPreviewContainer,
  supplier: Supplier | undefined,
  allStockItems: readonly StockItem[]
): Promise<FactoryTripPoValidation> {
  const parsed = parseFactoryTripPoIdentity(
    container.containerNumber,
    container.items.map((i) => i.poNumber)
  );
  const errors = [...parsed.errors];
  const resolvedItems: FactoryTripPoValidation["resolvedItems"] = [];
  if (!parsed.identity) return { identity: null, errors, resolvedItems, goodsTotal: null, supplierTotal: null };
  const supplierCode = String(container.supplierCode ?? "").trim();
  if (!supplier || !supplier.active || supplier.deletedAt || !supplierCode || supplier.code !== supplierCode) {
    errors.push(
      `ERP selected supplier must exactly match the file Supplier_Code "${supplierCode || "(missing)"}" and be active.`
    );
  }
  if (container.items.length === 0) errors.push("Factory dispatch PO has no article lines.");
  if (container.itemsCount !== container.items.length)
    errors.push("Factory PO item count does not match the signed file.");
  const seen = new Set<string>();
  const values: Decimal[] = [];
  for (const [index, item] of container.items.entries()) {
    // item.barcode is the file's Item_Barcode column: the exact ERP stock code/alias.
    const code = String(item.barcode ?? "").trim();
    if (String(item.supplierCode ?? "").trim() !== supplierCode) {
      errors.push(`ERP PO article ${code || index + 1}: Supplier_Code differs across rows or is missing.`);
    }
    if (!code || code.length > 50 || /^[=+@-]/.test(code)) {
      errors.push(`ERP PO row ${index + 1}: a valid article code is required, not a bale reference.`);
      continue;
    }
    if (seen.has(code.toUpperCase())) {
      errors.push(
        `ERP PO row ${index + 1}: repeated article code ${code}. A truck has one aggregated row per article.`
      );
      continue;
    }
    seen.add(code.toUpperCase());
    if (item.currency?.trim().toUpperCase() !== "USD") {
      errors.push(`ERP PO article ${code}: Factory dispatch export is USD-only.`);
    }
    if (!nonNegativeQuantity(item)) {
      errors.push(`ERP PO article ${code}: quantity must be a positive whole number of scanned bales.`);
    }
    const rate = numericMoney(item.rate);
    const lineTotal = roundedSourceAmount(item.lineTotal);
    if (!rate || !rate.gt(0) || !lineTotal || !rate.times(item.quantity).toDecimalPlaces(2).eq(lineTotal)) {
      errors.push(`ERP PO article ${code}: a positive two-decimal purchase rate and matching line total are required.`);
    } else values.push(lineTotal);
    // Code/alias lookup is company-scoped and intentionally exact-case, just
    // like the ERP importer. No risky name fallback for these trip files.
    const resolved = await storage.getStockItemByCodeOrAlias(code, companyId);
    if (!resolved || resolved.deletedAt || !allStockItems.some((a) => a.id === resolved.id)) {
      const caseSuggestion = allStockItems.find((a) => a.code.toUpperCase() === code.toUpperCase());
      errors.push(
        `ERP article "${code}" has no exact company-owned stock code/alias${caseSuggestion ? `; exact code is "${caseSuggestion.code}"` : ""}. Create the matching ERP code or alias; product-name fallback is disabled.`
      );
    } else {
      resolvedItems.push({ index, stockItemId: resolved.id, itemName: resolved.name });
    }
  }
  const amounts = container.charges;
  const chargeFields = ["freight", "surcharge", "fumigation", "discount", "documentCharges"] as const;
  const checked: Record<string, Decimal> = {};
  for (const key of chargeFields) {
    const value = roundedSourceAmount(amounts[key] ?? 0);
    if (!value) errors.push(`ERP invoice ${key} must be a nonnegative two-decimal USD amount.`);
    else checked[key] = value;
  }
  const itemTotal = sumMoney(values);
  // Round totals from the existing importer to cents without mistaking
  // harmless IEEE-754 summing artifacts for altered supplier amounts.
  const declaredGoods = roundedSourceAmount(container.itemsTotal);
  const declaredCharges = roundedSourceAmount(container.chargesTotal, true);
  const declaredTotal = roundedSourceAmount(container.grandTotal);
  const chargesTotal =
    checked.freight && checked.surcharge && checked.fumigation && checked.discount && checked.documentCharges
      ? checked.freight
          .plus(checked.surcharge)
          .plus(checked.fumigation)
          .plus(checked.documentCharges)
          .minus(checked.discount)
      : null;
  // chargesTotal can legitimately be negative for supplier discounts. It is
  // never the cost of a single article, just a container-level net adjustment.
  const declaredNetCharges = declaredCharges;
  const computed = chargesTotal ? itemTotal.plus(chargesTotal) : null;
  if (!declaredGoods || !itemTotal.eq(declaredGoods))
    errors.push("ERP PO item total does not match article quantities and purchase rates.");
  if (!chargesTotal || !declaredNetCharges || !chargesTotal.eq(declaredNetCharges))
    errors.push("ERP PO invoice charges do not reconcile.");
  if (!declaredTotal || !computed || !computed.eq(declaredTotal) || !computed.gt(0)) {
    errors.push("ERP supplier invoice grand total is invalid or inconsistent.");
  }
  if ((amounts.otherCharges ?? 0) !== 0) errors.push("Factory dispatch PO files do not support Other Charges.");
  return {
    identity: parsed.identity,
    errors,
    resolvedItems,
    goodsTotal: errors.length ? null : itemTotal.toFixed(2),
    supplierTotal: errors.length ? null : computed!.toFixed(2),
  };
}
