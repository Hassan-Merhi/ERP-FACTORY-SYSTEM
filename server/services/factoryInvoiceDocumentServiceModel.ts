/** Canonical factory invoice document types and the line grouping, ordering and labelling shared by the Excel and PDF renderers. */
import { buildSafeFilename } from "../lib/contentDisposition";
import { FACTORY_DOCUMENT_LABELS, type FactoryDocumentLanguage } from "./factoryDocumentLanguage";
import { FACTORY_INVOICE_EXTRA_LABELS } from "./factoryInvoiceTranslations";

export interface CanonicalInvoiceLine {
  articleCode: string;
  productName: string;
  productNameAr: string | null;
  productNameFr: string | null;
  category: string;
  categoryAr: string | null;
  categoryFr: string | null;
  qty: number;
  weightPerBale: number;
  totalWeight: number;
  pricingMode: "per_bale" | "per_kg";
  pricePerBale: number;
  pricePerKg: number;
  unitPrice: number;
  totalPrice: number;
}

export interface CanonicalInvoiceCharge {
  id: number;
  name: string;
  amount: number;
  chargeType: string;
}

export interface CanonicalInvoiceDocument {
  version: 1;
  orderId: number;
  companyId: number;
  invoiceNumber: string;
  orderDate: string;
  status: string;
  customerName: string;
  customerCode: string;
  baseCurrency: string;
  containerNumber: string;
  destination: string;
  shippingCompany: string;
  subtotalBales: number;
  freightAmount: number;
  otherChargesTotal: number;
  grandTotal: number;
  totalQtyBales: number;
  lines: CanonicalInvoiceLine[];
  charges: CanonicalInvoiceCharge[];
  frozenAt: string | null;
}

export interface InvoiceRenderOptions {
  hideSelling?: boolean;
  noCharges?: boolean;
  language?: FactoryDocumentLanguage;
}

export function safeString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}

export function currencySymbol(currency: unknown): string {
  const code = safeString(currency, "USD").toUpperCase();
  return (
    (
      {
        USD: "$",
        GBP: "£",
        EUR: "€",
        CFA: "CFA",
        XOF: "CFA",
        XAF: "CFA",
      } as Record<string, string>
    )[code] ?? code
  );
}

export function localizedLineProduct(line: CanonicalInvoiceLine, language: FactoryDocumentLanguage): string {
  if (language === "ar" && line.productNameAr?.trim()) return line.productNameAr.trim();
  if (language === "fr" && line.productNameFr?.trim()) return line.productNameFr.trim();
  return line.productName || line.articleCode;
}

export function localizedLineCategory(line: CanonicalInvoiceLine, language: FactoryDocumentLanguage): string {
  if (language === "ar" && line.categoryAr?.trim()) return line.categoryAr.trim();
  if (language === "fr" && line.categoryFr?.trim()) return line.categoryFr.trim();
  return line.category || "-";
}

interface InvoiceRenderGroup {
  key: string;
  label: string;
  sortBucket: number;
  sortNumber: number;
  lines: CanonicalInvoiceLine[];
  qty: number;
  totalWeight: number;
  totalPrice: number;
  subtotalUnitPrice: number | null;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function extractSeasonNumber(value: string): number | null {
  const match = value.match(/\b(?:summer|winter|number|no\.?|n[°º]|#)\s*[-:]?\s*(\d+)\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractCategoryNumber(value: string): number | null {
  const seasonNumber = extractSeasonNumber(value);
  if (seasonNumber !== null) return seasonNumber;

  const match = value.match(/\b(\d+)\b(?!\s*(?:kg|kgs|kilograms?|lb|lbs)\b)/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function lineSeasonRank(line: CanonicalInvoiceLine): number {
  const value = `${line.category} ${line.productName}`.toLowerCase();
  if (/\bsummer\b/.test(value)) return 0;
  if (/\bwinter\b/.test(value)) return 1;
  return 2;
}

export function buildInvoiceRenderGroups(
  document: CanonicalInvoiceDocument,
  language: FactoryDocumentLanguage
): InvoiceRenderGroup[] {
  const extraLabels = FACTORY_INVOICE_EXTRA_LABELS[language];
  const groups = new Map<
    string,
    Omit<InvoiceRenderGroup, "qty" | "totalWeight" | "totalPrice" | "subtotalUnitPrice">
  >();

  for (const line of document.lines) {
    const rawCategory = line.category.trim();
    const categoryText = rawCategory.toLowerCase();
    const seasonNumber = extractSeasonNumber(rawCategory) ?? extractSeasonNumber(line.productName);
    const categoryNumber = extractCategoryNumber(rawCategory);
    let key: string;
    let label: string;
    let sortBucket: number;
    let sortNumber: number;

    if (/\bcream\b/i.test(rawCategory)) {
      key = "cream";
      label = extraLabels.creamGroup;
      sortBucket = 0;
      sortNumber = 0;
    } else if (categoryNumber !== null || seasonNumber !== null) {
      const number = categoryNumber ?? seasonNumber!;
      key = `number:${number}`;
      label = `${extraLabels.numberGroup} ${number}`;
      sortBucket = 1;
      sortNumber = number;
    } else {
      key = `category:${categoryText || "__uncategorized__"}`;
      label = rawCategory ? localizedLineCategory(line, language) : extraLabels.uncategorizedGroup;
      sortBucket = 2;
      sortNumber = Number.MAX_SAFE_INTEGER;
    }

    const existing = groups.get(key);
    if (existing) {
      existing.lines.push(line);
    } else {
      groups.set(key, { key, label, sortBucket, sortNumber, lines: [line] });
    }
  }

  return [...groups.values()]
    .map((group) => {
      const lines = [...group.lines].sort((a, b) => {
        const aNumber =
          extractSeasonNumber(a.category) ?? extractSeasonNumber(a.productName) ?? Number.MAX_SAFE_INTEGER;
        const bNumber =
          extractSeasonNumber(b.category) ?? extractSeasonNumber(b.productName) ?? Number.MAX_SAFE_INTEGER;
        if (aNumber !== bNumber) return aNumber - bNumber;

        const seasonDiff = lineSeasonRank(a) - lineSeasonRank(b);
        if (seasonDiff !== 0) return seasonDiff;

        const productDiff = naturalCompare(localizedLineProduct(a, language), localizedLineProduct(b, language));
        if (productDiff !== 0) return productDiff;
        return naturalCompare(a.articleCode, b.articleCode);
      });

      const qty = lines.reduce((sum, line) => sum + line.qty, 0);
      const totalWeight = lines.reduce((sum, line) => sum + line.totalWeight, 0);
      const totalPrice = lines.reduce((sum, line) => sum + line.totalPrice, 0);
      const modes = new Set(lines.map((line) => line.pricingMode));
      const subtotalUnitPrice =
        modes.size !== 1
          ? null
          : modes.has("per_kg")
            ? totalWeight > 0
              ? totalPrice / totalWeight
              : null
            : qty > 0
              ? totalPrice / qty
              : null;

      return { ...group, lines, qty, totalWeight, totalPrice, subtotalUnitPrice };
    })
    .sort((a, b) => {
      if (a.sortBucket !== b.sortBucket) return a.sortBucket - b.sortBucket;
      if (a.sortNumber !== b.sortNumber) return a.sortNumber - b.sortNumber;
      return naturalCompare(a.label, b.label);
    });
}

export function buildCanonicalInvoiceFilename(document: CanonicalInvoiceDocument, extension: "xlsx" | "pdf"): string {
  return buildSafeFilename(
    [document.containerNumber, document.customerName, document.destination, document.invoiceNumber],
    extension
  );
}

export function unitPriceLabel(document: CanonicalInvoiceDocument, language: FactoryDocumentLanguage): string {
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const modes = new Set(document.lines.map((line) => line.pricingMode));
  if (modes.size > 1) return labels.unitPrice;
  return modes.has("per_kg") ? labels.pricePerKg : labels.pricePerBale;
}
