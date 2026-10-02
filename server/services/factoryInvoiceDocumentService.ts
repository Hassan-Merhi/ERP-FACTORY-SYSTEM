import fs from "fs";
import path from "path";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { buildSafeFilename } from "../lib/contentDisposition";
import {
  FACTORY_DOCUMENT_LABELS,
  applyFactoryPdfLanguage,
  configureFactoryArabicWorksheet,
  type FactoryDocumentLanguage,
} from "./factoryDocumentLanguage";
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

type HeaderRow = {
  id: unknown;
  company_id: unknown;
  invoice_number: unknown;
  order_date: unknown;
  status: unknown;
  subtotal_bales: unknown;
  freight_amount: unknown;
  other_charges_total: unknown;
  grand_total: unknown;
  total_qty_bales: unknown;
  container_number: unknown;
  destination: unknown;
  shipping_company: unknown;
  customer_name: unknown;
  customer_code: unknown;
  base_currency: unknown;
};

type LineRow = {
  id: unknown;
  article_code: unknown;
  bale_name: unknown;
  bale_name_ar: unknown;
  bale_name_fr: unknown;
  qty: unknown;
  weight_per_bale: unknown;
  total_weight: unknown;
  pricing_mode: unknown;
  price_per_bale: unknown;
  price_per_kg: unknown;
  total_price: unknown;
  category_name: unknown;
  category_name_ar: unknown;
  category_name_fr: unknown;
};

type ChargeRow = {
  id: unknown;
  name: unknown;
  amount: unknown;
  charge_type: unknown;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function safeString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}

function safeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePricingMode(value: unknown): "per_bale" | "per_kg" {
  return String(value || "").toLowerCase() === "per_kg" ? "per_kg" : "per_bale";
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

function excelMoneyFormat(currency: string): string {
  const symbol = currencySymbol(currency);
  if (symbol === "CFA") return '"CFA " #,##0.00';
  if (symbol.length <= 3) return `"${symbol}"#,##0.00`;
  return `"${symbol} "#,##0.00`;
}

function localizedLineProduct(line: CanonicalInvoiceLine, language: FactoryDocumentLanguage): string {
  if (language === "ar" && line.productNameAr?.trim()) return line.productNameAr.trim();
  if (language === "fr" && line.productNameFr?.trim()) return line.productNameFr.trim();
  return line.productName || line.articleCode;
}

function localizedLineCategory(line: CanonicalInvoiceLine, language: FactoryDocumentLanguage): string {
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
  const match = value.match(/\\b(?:summer|winter|number|no\\.?|n[°º]|#)\\s*[-:]?\\s*(\\d+)\\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractCategoryNumber(value: string): number | null {
  const seasonNumber = extractSeasonNumber(value);
  if (seasonNumber !== null) return seasonNumber;

  const match = value.match(/\\b(\\d+)\\b(?!\\s*(?:kg|kgs|kilograms?|lb|lbs)\\b)/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function lineSeasonRank(line: CanonicalInvoiceLine): number {
  const value = `${line.category} ${line.productName}`.toLowerCase();
  if (/\\bsummer\\b/.test(value)) return 0;
  if (/\\bwinter\\b/.test(value)) return 1;
  return 2;
}

function buildInvoiceRenderGroups(
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

    if (/\\bcream\\b/i.test(rawCategory)) {
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
      const fallbackCategory = rawCategory || extraLabels.uncategorizedGroup;
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
        const aNumber = extractSeasonNumber(a.category) ?? extractSeasonNumber(a.productName) ?? Number.MAX_SAFE_INTEGER;
        const bNumber = extractSeasonNumber(b.category) ?? extractSeasonNumber(b.productName) ?? Number.MAX_SAFE_INTEGER;
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

function isCanonicalSnapshot(value: unknown): value is CanonicalInvoiceDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanonicalInvoiceDocument>;
  return candidate.version === 1 && Number.isInteger(candidate.orderId) && Array.isArray(candidate.lines);
}

export async function ensureFactoryInvoiceDocumentSnapshotStore(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_invoice_document_snapshots (
      order_id INTEGER PRIMARY KEY REFERENCES customer_orders(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      snapshot JSONB NOT NULL,
      frozen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS factory_invoice_document_snapshots_company_idx
      ON factory_invoice_document_snapshots(company_id, order_id)
  `);
}

async function readUsableSnapshot(orderId: number, companyId: number): Promise<CanonicalInvoiceDocument | null> {
  const result = await db.execute(sql`
    SELECT s.snapshot, co.status AS current_status
    FROM factory_invoice_document_snapshots s
    INNER JOIN customer_orders co ON co.id = s.order_id AND co.company_id = s.company_id
    WHERE s.order_id = ${orderId} AND s.company_id = ${companyId}
    LIMIT 1
  `);
  const row = resultRows<{ snapshot: unknown; current_status: unknown }>(result)[0];
  if (!row || String(row.current_status || "") !== "FINALIZED" || !isCanonicalSnapshot(row.snapshot)) return null;
  return row.snapshot;
}

async function buildLiveCanonicalInvoiceDocument(
  orderId: number,
  companyId: number
): Promise<CanonicalInvoiceDocument | null> {
  const headerResult = await db.execute(sql`
    SELECT
      co.id,
      co.company_id,
      co.invoice_number,
      co.order_date,
      co.status,
      co.subtotal_bales,
      co.freight_amount,
      co.other_charges_total,
      co.grand_total,
      co.total_qty_bales,
      co.container_number,
      co.destination,
      co.shipping_company,
      c.legal_name AS customer_name,
      c.code AS customer_code,
      cmp.base_currency
    FROM customer_orders co
    LEFT JOIN customers c ON c.id = co.customer_id
    LEFT JOIN companies cmp ON cmp.id = co.company_id
    WHERE co.id = ${orderId} AND co.company_id = ${companyId}
    LIMIT 1
  `);
  const header = resultRows<HeaderRow>(headerResult)[0];
  if (!header) return null;

  const lineResult = await db.execute(sql`
    SELECT
      col.id,
      col.article_code,
      col.bale_name,
      col.bale_name_ar,
      col.bale_name_fr,
      col.qty,
      col.weight_per_bale,
      col.total_weight,
      col.pricing_mode,
      col.price_per_bale,
      col.price_per_kg,
      col.total_price,
      COALESCE(
        NULLIF((
          SELECT NULLIF(BTRIM(fb.category), '')
          FROM customer_order_bales cob
          INNER JOIN factory_bales fb
            ON fb.id = cob.bale_id
           AND fb.company_id = co.company_id
          WHERE cob.order_id = col.order_id
            AND UPPER(BTRIM(COALESCE(cob.article_code, fb.article_code, ''))) = UPPER(BTRIM(col.article_code))
            AND NULLIF(BTRIM(fb.category), '') IS NOT NULL
          ORDER BY cob.id
          LIMIT 1
        ), ''),
        fc.name,
        ''
      ) AS category_name,
      COALESCE(
        NULLIF((
          SELECT NULLIF(BTRIM(fb.category_ar), '')
          FROM customer_order_bales cob
          INNER JOIN factory_bales fb
            ON fb.id = cob.bale_id
           AND fb.company_id = co.company_id
          WHERE cob.order_id = col.order_id
            AND UPPER(BTRIM(COALESCE(cob.article_code, fb.article_code, ''))) = UPPER(BTRIM(col.article_code))
            AND NULLIF(BTRIM(fb.category_ar), '') IS NOT NULL
          ORDER BY cob.id
          LIMIT 1
        ), ''),
        fc.name_ar
      ) AS category_name_ar,
      COALESCE(
        NULLIF((
          SELECT NULLIF(BTRIM(fb.category_fr), '')
          FROM customer_order_bales cob
          INNER JOIN factory_bales fb
            ON fb.id = cob.bale_id
           AND fb.company_id = co.company_id
          WHERE cob.order_id = col.order_id
            AND UPPER(BTRIM(COALESCE(cob.article_code, fb.article_code, ''))) = UPPER(BTRIM(col.article_code))
            AND NULLIF(BTRIM(fb.category_fr), '') IS NOT NULL
          ORDER BY cob.id
          LIMIT 1
        ), ''),
        fc.name_fr
      ) AS category_name_fr
    FROM customer_order_lines col
    INNER JOIN customer_orders co ON co.id = col.order_id
    LEFT JOIN factory_bale_products fp
      ON fp.company_id = co.company_id
     AND fp.deleted_at IS NULL
     AND UPPER(BTRIM(COALESCE(fp.article_code, ''))) = UPPER(BTRIM(col.article_code))
    LEFT JOIN factory_categories fc
      ON fc.id = fp.category_id
     AND fc.company_id = co.company_id
     AND fc.deleted_at IS NULL
    WHERE col.order_id = ${orderId}
      AND co.company_id = ${companyId}
    ORDER BY UPPER(BTRIM(col.article_code)), col.id
  `);

  const lines = resultRows<LineRow>(lineResult).map((row) => {
    const pricingMode = normalizePricingMode(row.pricing_mode);
    const totalWeight = safeNumber(row.total_weight);
    const totalPrice = safeNumber(row.total_price);
    const storedPerKg = safeNumber(row.price_per_kg);
    const derivedPerKg = totalWeight > 0 ? totalPrice / totalWeight : 0;
    const pricePerKg = storedPerKg > 0 ? storedPerKg : derivedPerKg;
    const pricePerBale = safeNumber(row.price_per_bale);
    return {
      articleCode: safeString(row.article_code),
      productName: safeString(row.bale_name, safeString(row.article_code)),
      productNameAr: row.bale_name_ar == null ? null : safeString(row.bale_name_ar),
      productNameFr: row.bale_name_fr == null ? null : safeString(row.bale_name_fr),
      category: safeString(row.category_name),
      categoryAr: row.category_name_ar == null ? null : safeString(row.category_name_ar),
      categoryFr: row.category_name_fr == null ? null : safeString(row.category_name_fr),
      qty: safeNumber(row.qty),
      weightPerBale: safeNumber(row.weight_per_bale),
      totalWeight,
      pricingMode,
      pricePerBale,
      pricePerKg,
      unitPrice: pricingMode === "per_kg" ? pricePerKg : pricePerBale,
      totalPrice,
    } satisfies CanonicalInvoiceLine;
  });

  const chargeResult = await db.execute(sql`
    SELECT id, name, amount, charge_type
    FROM customer_order_charges
    WHERE order_id = ${orderId}
    ORDER BY id
  `);
  const charges = resultRows<ChargeRow>(chargeResult).map(
    (row) =>
      ({
        id: safeNumber(row.id),
        name: safeString(row.name, "Charge"),
        amount: safeNumber(row.amount),
        chargeType: safeString(row.charge_type, "OTHER"),
      }) satisfies CanonicalInvoiceCharge
  );

  return {
    version: 1,
    orderId: safeNumber(header.id),
    companyId: safeNumber(header.company_id),
    invoiceNumber: safeString(header.invoice_number) || `INV-${String(orderId).padStart(6, "0")}`,
    orderDate: safeString(header.order_date),
    status: safeString(header.status),
    customerName: safeString(header.customer_name, "-"),
    customerCode: safeString(header.customer_code),
    baseCurrency: safeString(header.base_currency, "USD").toUpperCase(),
    containerNumber: safeString(header.container_number),
    destination: safeString(header.destination),
    shippingCompany: safeString(header.shipping_company),
    subtotalBales: safeNumber(header.subtotal_bales),
    freightAmount: safeNumber(header.freight_amount),
    otherChargesTotal: safeNumber(header.other_charges_total),
    grandTotal: safeNumber(header.grand_total),
    totalQtyBales: safeNumber(header.total_qty_bales),
    lines,
    charges,
    frozenAt: null,
  };
}

async function persistSnapshot(document: CanonicalInvoiceDocument, force: boolean): Promise<CanonicalInvoiceDocument> {
  const frozen: CanonicalInvoiceDocument = {
    ...document,
    lines: document.lines.map((line) => ({ ...line })),
    charges: document.charges.map((charge) => ({ ...charge })),
    frozenAt: new Date().toISOString(),
  };
  const payload = JSON.stringify(frozen);

  if (force) {
    await db.execute(sql`
      INSERT INTO factory_invoice_document_snapshots (order_id, company_id, snapshot, frozen_at, updated_at)
      VALUES (${document.orderId}, ${document.companyId}, ${payload}::jsonb, NOW(), NOW())
      ON CONFLICT (order_id) DO UPDATE
      SET company_id = EXCLUDED.company_id,
          snapshot = EXCLUDED.snapshot,
          frozen_at = EXCLUDED.frozen_at,
          updated_at = NOW()
    `);
    return frozen;
  }

  const inserted = await db.execute(sql`
    INSERT INTO factory_invoice_document_snapshots (order_id, company_id, snapshot, frozen_at, updated_at)
    VALUES (${document.orderId}, ${document.companyId}, ${payload}::jsonb, NOW(), NOW())
    ON CONFLICT (order_id) DO NOTHING
    RETURNING snapshot
  `);
  const insertedSnapshot = resultRows<{ snapshot: unknown }>(inserted)[0]?.snapshot;
  if (isCanonicalSnapshot(insertedSnapshot)) return insertedSnapshot;
  return (await readUsableSnapshot(document.orderId, document.companyId)) ?? frozen;
}

export async function getCanonicalInvoiceDocument(
  orderId: number,
  companyId: number
): Promise<CanonicalInvoiceDocument | null> {
  const existing = await readUsableSnapshot(orderId, companyId);
  if (existing) return existing;

  const live = await buildLiveCanonicalInvoiceDocument(orderId, companyId);
  if (!live) return null;
  if (live.status === "FINALIZED") return persistSnapshot(live, false);
  return live;
}

export async function freezeCanonicalInvoiceDocument(
  orderId: number,
  companyId: number,
  force = true
): Promise<CanonicalInvoiceDocument | null> {
  const live = await buildLiveCanonicalInvoiceDocument(orderId, companyId);
  if (!live) return null;
  if (live.status !== "FINALIZED") return live;
  return persistSnapshot(live, force);
}

export function buildCanonicalInvoiceFilename(document: CanonicalInvoiceDocument, extension: "xlsx" | "pdf"): string {
  return buildSafeFilename(
    [document.containerNumber, document.customerName, document.destination, document.invoiceNumber],
    extension
  );
}

function unitPriceLabel(document: CanonicalInvoiceDocument, language: FactoryDocumentLanguage): string {
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const modes = new Set(document.lines.map((line) => line.pricingMode));
  if (modes.size > 1) return labels.unitPrice;
  return modes.has("per_kg") ? labels.pricePerKg : labels.pricePerBale;
}

export async function buildCanonicalInvoiceExcel(
  document: CanonicalInvoiceDocument,
  options: InvoiceRenderOptions = {}
): Promise<{ buffer: Buffer; fileName: string }> {
  const language = options.language ?? "en";
  const hideSelling = options.hideSelling === true;
  const noCharges = options.noCharges === true;
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(labels.commercialInvoice.slice(0, 31), {
    views: language === "ar" ? [{ rightToLeft: true, showGridLines: false }] : [{ showGridLines: false }],
  });

  const columns = hideSelling ? [6, 16, 30, 18, 8, 11, 13] : [6, 16, 28, 18, 8, 11, 13, 13, 14];
  sheet.columns = columns.map((width) => ({ width }));
  const COL = columns.length;
  const DARK_BLUE = "FF1F3864";
  const LIGHT_GRAY = "FFF5F5F5";
  const WHITE = "FFFFFFFF";
  const moneyFmt = excelMoneyFormat(document.baseCurrency);

  const logoRow = sheet.addRow([]);
  logoRow.height = 20;

  const companyRow = sheet.addRow(["HMD INTERNATIONAL GROUP"]);
  companyRow.height = 26;
  companyRow.getCell(1).font = { bold: true, size: 16, color: { argb: DARK_BLUE } };
  companyRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  sheet.mergeCells(companyRow.number, 1, companyRow.number, COL);

  const titleRow = sheet.addRow([labels.commercialInvoice]);
  titleRow.height = 22;
  titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: DARK_BLUE } };
  titleRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, COL);
  sheet.addRow([]);

  const detailPairs: Array<[string, string]> = [
    [labels.invoiceNo, document.invoiceNumber],
    [labels.customer, document.customerName || "-"],
    [labels.date, document.orderDate || "-"],
    [labels.container, document.containerNumber || "-"],
    [labels.destination, document.destination || "-"],
    [labels.status, document.status.replaceAll("_", " ")],
  ];
  const valueColumn = COL;
  const labelStart = Math.max(1, COL - 2);
  for (const [label, value] of detailPairs) {
    const values = Array(COL).fill("");
    values[labelStart - 1] = label;
    values[valueColumn - 1] = value;
    const row = sheet.addRow(values);
    row.height = 20;
    row.getCell(labelStart).font = { bold: true, size: 10 };
    row.getCell(labelStart).alignment = { horizontal: "right" };
    row.getCell(valueColumn).font = { size: 10 };
    row.getCell(valueColumn).alignment = { horizontal: "left" };
    if (valueColumn - labelStart > 1) {
      sheet.mergeCells(row.number, labelStart, row.number, valueColumn - 1);
    }
  }
  sheet.addRow([]);

  const headers = [
    "#",
    labels.articleCode,
    labels.product,
    labels.category,
    labels.quantity,
    labels.weightPerBale,
    labels.totalWeight,
    ...(hideSelling ? [] : [unitPriceLabel(document, language), labels.total]),
  ];
  const headerRow = sheet.addRow(headers);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_BLUE } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: WHITE } },
      bottom: { style: "thin", color: { argb: WHITE } },
      left: { style: "thin", color: { argb: WHITE } },
      right: { style: "thin", color: { argb: WHITE } },
    };
  });

  const renderGroups = buildInvoiceRenderGroups(document, language);
  let totalQty = 0;
  let totalWeight = 0;
  let totalAmount = 0;
  let lineNumber = 0;
  let stripeIndex = 0;

  for (const group of renderGroups) {
    for (const line of group.lines) {
      lineNumber += 1;
      totalQty += line.qty;
      totalWeight += line.totalWeight;
      totalAmount += line.totalPrice;
      const values: Array<string | number> = [
        lineNumber,
        line.articleCode,
        localizedLineProduct(line, language),
        localizedLineCategory(line, language),
        line.qty,
        line.weightPerBale,
        line.totalWeight,
      ];
      if (!hideSelling) values.push(line.unitPrice, line.totalPrice);
      const row = sheet.addRow(values);
      row.height = 20;
      row.eachCell((cell) => {
        cell.font = { size: 10 };
        cell.alignment = { vertical: "middle", wrapText: true };
        cell.border = {
          top: { style: "thin", color: { argb: "FFDDDDDD" } },
          bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
          left: { style: "thin", color: { argb: "FFDDDDDD" } },
          right: { style: "thin", color: { argb: "FFDDDDDD" } },
        };
      });
      if (stripeIndex % 2 === 1) {
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_GRAY } };
        });
      }
      stripeIndex += 1;
      row.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
      row.getCell(5).numFmt = "#,##0";
      row.getCell(6).numFmt = "#,##0.00";
      row.getCell(7).numFmt = "#,##0.00";
      if (!hideSelling) {
        row.getCell(8).numFmt = moneyFmt;
        row.getCell(9).numFmt = moneyFmt;
      }
    }

    const subtotalValues: Array<string | number> = [
      "",
      "",
      `${FACTORY_INVOICE_EXTRA_LABELS[language].subtotalPrefix} ${group.label}`,
      "",
      group.qty,
      "",
      group.totalWeight,
    ];
    if (!hideSelling) subtotalValues.push(group.subtotalUnitPrice ?? "", group.totalPrice);
    const subtotalRow = sheet.addRow(subtotalValues);
    subtotalRow.height = 22;
    subtotalRow.eachCell((cell) => {
      cell.font = { bold: true, size: 10, color: { argb: DARK_BLUE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_GRAY } };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: DARK_BLUE } },
        bottom: { style: "thin", color: { argb: DARK_BLUE } },
        left: { style: "thin", color: { argb: "FFDDDDDD" } },
        right: { style: "thin", color: { argb: "FFDDDDDD" } },
      };
    });
    subtotalRow.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
    subtotalRow.getCell(5).numFmt = "#,##0";
    subtotalRow.getCell(7).numFmt = "#,##0.00";
    if (!hideSelling) {
      subtotalRow.getCell(8).numFmt = moneyFmt;
      subtotalRow.getCell(9).numFmt = moneyFmt;
    }
  }

  const totalValues: Array<string | number> = ["", "", labels.totals, "", totalQty, "", totalWeight];
  if (!hideSelling) totalValues.push("", totalAmount);
  const totalRow = sheet.addRow(totalValues);
  totalRow.height = 22;
  totalRow.eachCell((cell) => {
    cell.font = { bold: true, size: 10, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_BLUE } };
    cell.alignment = { horizontal: "right", vertical: "middle" };
  });
  totalRow.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
  totalRow.getCell(5).numFmt = "#,##0";
  totalRow.getCell(7).numFmt = "#,##0.00";
  if (!hideSelling) totalRow.getCell(9).numFmt = moneyFmt;

  if (!hideSelling && !noCharges) {
    sheet.addRow([]);
    const otherChargeLines = document.charges.filter((charge) => charge.chargeType !== "FREIGHT");
    const summaryRows: Array<[string, number]> = [
      [labels.subtotal, document.subtotalBales],
      ...(document.freightAmount > 0 ? ([[labels.freight, document.freightAmount]] as Array<[string, number]>) : []),
      ...(otherChargeLines.length > 0
        ? otherChargeLines.map((charge) => [charge.name || labels.otherCharges, charge.amount] as [string, number])
        : document.otherChargesTotal > 0
          ? ([[labels.otherCharges, document.otherChargesTotal]] as Array<[string, number]>)
          : []),
      [labels.grandTotal, document.grandTotal],
    ];
    const summaryLabelCol = COL - 1;
    const summaryValueCol = COL;
    const summaryHeaderValues = Array(COL).fill("");
    summaryHeaderValues[summaryLabelCol - 1] = labels.name;
    summaryHeaderValues[summaryValueCol - 1] = labels.amount;
    const summaryHeader = sheet.addRow(summaryHeaderValues);
    for (const col of [summaryLabelCol, summaryValueCol]) {
      summaryHeader.getCell(col).font = { bold: true, color: { argb: WHITE }, size: 10 };
      summaryHeader.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_BLUE } };
      summaryHeader.getCell(col).alignment = { horizontal: "center" };
    }

    summaryRows.forEach(([label, amount], index) => {
      const values = Array(COL).fill("");
      values[summaryLabelCol - 1] = label;
      values[summaryValueCol - 1] = amount;
      const row = sheet.addRow(values);
      const isGrand = index === summaryRows.length - 1;
      for (const col of [summaryLabelCol, summaryValueCol]) {
        row.getCell(col).font = { bold: isGrand, size: 10, color: { argb: isGrand ? WHITE : "FF000000" } };
        row.getCell(col).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: isGrand ? DARK_BLUE : index % 2 === 0 ? WHITE : LIGHT_GRAY },
        };
        row.getCell(col).border = {
          top: { style: "thin", color: { argb: "FFDDDDDD" } },
          bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
          left: { style: "thin", color: { argb: "FFDDDDDD" } },
          right: { style: "thin", color: { argb: "FFDDDDDD" } },
        };
      }
      row.getCell(summaryValueCol).numFmt = moneyFmt;
      row.getCell(summaryValueCol).alignment = { horizontal: "right" };
    });
  }

  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
  sheet.pageSetup.printTitlesRow = `${headerRow.number}:${headerRow.number}`;
  if (language === "ar") configureFactoryArabicWorksheet(sheet, language);

  const raw = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw as ArrayBuffer);
  if (buffer.length < 2 || buffer.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error(FACTORY_INVOICE_EXTRA_LABELS.en.invalidWorkbook);
  }
  return { buffer, fileName: buildCanonicalInvoiceFilename(document, "xlsx") };
}

function concatBuffers(chunks: Buffer[]): Buffer {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  for (const chunk of chunks) {
    chunk.copy(output, offset);
    offset += chunk.length;
  }
  return output;
}

export async function buildCanonicalInvoicePdf(
  document: CanonicalInvoiceDocument,
  options: InvoiceRenderOptions = {}
): Promise<{ buffer: Buffer; fileName: string }> {
  const language = options.language ?? "en";
  const hideSelling = options.hideSelling === true;
  const noCharges = options.noCharges === true;
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ margin: 32, size: "A4", layout: "landscape", bufferPages: false });
  applyFactoryPdfLanguage(doc, language);

  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(concatBuffers(chunks)));
    doc.on("error", reject);
  });

  const pageLeft = 32;
  const pageRight = doc.page.width - 32;
  const usableWidth = pageRight - pageLeft;
  const rtl = language === "ar";
  const textAlign: "left" | "right" = rtl ? "right" : "left";
  const normalFont = () => {
    if (rtl) applyFactoryPdfLanguage(doc, language);
    else doc.font("Helvetica");
    return doc;
  };
  const boldFont = () => {
    if (rtl) applyFactoryPdfLanguage(doc, language);
    else doc.font("Helvetica-Bold");
    return doc;
  };
  const symbol = currencySymbol(document.baseCurrency);
  const money = (value: number) =>
    symbol === "CFA"
      ? `CFA ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${symbol}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const number = (value: number) =>
    value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const drawPageBranding = (firstPage: boolean) => {
    let y = 26;
    if (firstPage) {
      const logo = path.join(process.cwd(), "server", "hmd-logo.png");
      if (fs.existsSync(logo)) {
        try {
          doc.image(logo, (doc.page.width - 150) / 2, 18, { width: 150 });
          y = 82;
        } catch {
          y = 28;
        }
      }
    }
    boldFont()
      .fontSize(firstPage ? 14 : 10)
      .fillColor("#000000");
    doc.text(firstPage ? labels.invoice : `${labels.invoice} — ${document.invoiceNumber}`, pageLeft, y, {
      width: usableWidth,
      align: "center",
    });
    y = doc.y + 6;
    if (firstPage) {
      doc.moveTo(pageLeft, y).lineTo(pageRight, y).lineWidth(0.5).strokeColor("#cccccc").stroke();
      y += 9;
      const leftMeta: Array<[string, string]> = [
        [labels.invoiceNo, document.invoiceNumber],
        [labels.customer, document.customerName || "-"],
        [labels.date, document.orderDate || "-"],
      ];
      const rightMeta: Array<[string, string]> = [
        [labels.container, document.containerNumber || "-"],
        [labels.destination, document.destination || "-"],
        [labels.status, document.status.replaceAll("_", " ")],
      ];
      normalFont().fontSize(8).fillColor("#000000");
      let metaY = y;
      for (let i = 0; i < Math.max(leftMeta.length, rightMeta.length); i++) {
        const left = leftMeta[i];
        const right = rightMeta[i];
        if (left) {
          boldFont().text(`${left[0]}: `, pageLeft, metaY, { continued: true, width: usableWidth / 2 - 10 });
          normalFont().text(left[1]);
        }
        if (right) {
          const rightX = pageLeft + usableWidth / 2;
          boldFont().text(`${right[0]}: `, rightX, metaY, {
            continued: true,
            width: usableWidth / 2,
            align: textAlign,
          });
          normalFont().text(right[1], { align: textAlign });
        }
        metaY += 13;
      }
      y = metaY + 4;
    } else {
      y += 3;
    }
    return y;
  };

  const columnDefs = hideSelling
    ? [
        { key: "index", title: "#", width: 28, align: "center" as const },
        { key: "code", title: labels.articleCode, width: 86, align: textAlign },
        { key: "product", title: labels.product, width: 240, align: textAlign },
        { key: "category", title: labels.category, width: 145, align: textAlign },
        { key: "qty", title: labels.quantity, width: 48, align: "right" as const },
        { key: "wtBale", title: labels.weightPerBale, width: 72, align: "right" as const },
        { key: "totalWt", title: labels.totalWeight, width: 78, align: "right" as const },
      ]
    : [
        { key: "index", title: "#", width: 26, align: "center" as const },
        { key: "code", title: labels.articleCode, width: 76, align: textAlign },
        { key: "product", title: labels.product, width: 185, align: textAlign },
        { key: "category", title: labels.category, width: 105, align: textAlign },
        { key: "qty", title: labels.quantity, width: 40, align: "right" as const },
        { key: "wtBale", title: labels.weightPerBale, width: 58, align: "right" as const },
        { key: "totalWt", title: labels.totalWeight, width: 64, align: "right" as const },
        { key: "price", title: unitPriceLabel(document, language), width: 78, align: "right" as const },
        { key: "total", title: labels.total, width: 82, align: "right" as const },
      ];

  const totalColumnWidth = columnDefs.reduce((sum, column) => sum + column.width, 0);
  const scale = usableWidth / totalColumnWidth;
  const columns = columnDefs.map((column) => ({ ...column, width: column.width * scale }));
  const drawTableHeader = (y: number) => {
    const height = 18;
    doc.rect(pageLeft, y, usableWidth, height).fill("#1F3864");
    boldFont().fillColor("#ffffff").fontSize(7.5);
    let x = pageLeft;
    for (const column of columns) {
      doc.text(column.title, x + 2, y + 5, {
        width: column.width - 4,
        align: column.align,
        lineBreak: false,
      });
      x += column.width;
    }
    normalFont().fillColor("#000000").fontSize(7.5);
    return y + height;
  };

  let y = drawTableHeader(drawPageBranding(true));
  let totalQty = 0;
  let totalWeight = 0;
  let totalAmount = 0;
  let lineNumber = 0;
  let stripeIndex = 0;
  const renderGroups = buildInvoiceRenderGroups(document, language);

  for (const group of renderGroups) {
    for (const line of group.lines) {
      lineNumber += 1;
      totalQty += line.qty;
      totalWeight += line.totalWeight;
      totalAmount += line.totalPrice;
      const product = localizedLineProduct(line, language);
      const category = localizedLineCategory(line, language);
      const productHeight = doc.heightOfString(product, { width: columns[2].width - 4, align: textAlign });
      const categoryHeight = doc.heightOfString(category, { width: columns[3].width - 4, align: textAlign });
      const rowHeight = Math.max(16, Math.min(34, Math.max(productHeight, categoryHeight) + 6));

      if (y + rowHeight > doc.page.height - 42) {
        doc.addPage();
        y = drawTableHeader(drawPageBranding(false));
      }

      if (stripeIndex % 2 === 1) {
        doc.rect(pageLeft, y, usableWidth, rowHeight).fill("#F5F5F5");
        doc.fillColor("#000000");
      }
      stripeIndex += 1;

      const values: string[] = [
        String(lineNumber),
        line.articleCode,
        product,
        category,
        number(line.qty),
        number(line.weightPerBale),
        number(line.totalWeight),
        ...(hideSelling ? [] : [money(line.unitPrice), money(line.totalPrice)]),
      ];

      let x = pageLeft;
      values.forEach((value, columnIndex) => {
        const column = columns[columnIndex];
        doc.text(value, x + 2, y + 4, {
          width: column.width - 4,
          align: column.align,
          height: rowHeight - 6,
          ellipsis: true,
        });
        x += column.width;
      });
      y += rowHeight;
    }

    const subtotalHeight = 18;
    if (y + subtotalHeight > doc.page.height - 42) {
      doc.addPage();
      y = drawTableHeader(drawPageBranding(false));
    }

    doc.rect(pageLeft, y, usableWidth, subtotalHeight).fill("#F5F5F5");
    boldFont().fillColor("#1F3864").fontSize(8);
    const subtotalValues: string[] = [
      "",
      "",
      `${FACTORY_INVOICE_EXTRA_LABELS[language].subtotalPrefix} ${group.label}`,
      "",
      number(group.qty),
      "",
      number(group.totalWeight),
      ...(hideSelling
        ? []
        : [group.subtotalUnitPrice == null ? "" : money(group.subtotalUnitPrice), money(group.totalPrice)]),
    ];
    let subtotalX = pageLeft;
    subtotalValues.forEach((value, columnIndex) => {
      const column = columns[columnIndex];
      if (value) {
        doc.text(value, subtotalX + 2, y + 5, {
          width: column.width - 4,
          align: columnIndex === 2 ? "center" : column.align,
          lineBreak: false,
        });
      }
      subtotalX += column.width;
    });
    normalFont().fillColor("#000000").fontSize(7.5);
    y += subtotalHeight;
  }

  if (y + 20 > doc.page.height - 42) {
    doc.addPage();
    y = drawTableHeader(drawPageBranding(false));
  }
  doc.rect(pageLeft, y, usableWidth, 18).fill("#EEF2F9");
  boldFont().fillColor("#000000").fontSize(8);
  const totalValues: string[] = [
    "",
    "",
    labels.totals,
    "",
    number(totalQty),
    "",
    number(totalWeight),
    ...(hideSelling ? [] : ["", money(totalAmount)]),
  ];
  let totalX = pageLeft;
  totalValues.forEach((value, columnIndex) => {
    const column = columns[columnIndex];
    if (value) {
      doc.text(value, totalX + 2, y + 5, { width: column.width - 4, align: column.align, lineBreak: false });
    }
    totalX += column.width;
  });
  y += 26;

  if (!hideSelling && !noCharges) {
    const otherChargeLines = document.charges.filter((charge) => charge.chargeType !== "FREIGHT");
    const summaryRows: Array<[string, number, boolean]> = [
      [labels.subtotal, document.subtotalBales, false],
      ...(document.freightAmount > 0
        ? ([[labels.freight, document.freightAmount, false]] as Array<[string, number, boolean]>)
        : []),
      ...(otherChargeLines.length > 0
        ? otherChargeLines.map(
            (charge) => [charge.name || labels.otherCharges, charge.amount, false] as [string, number, boolean]
          )
        : document.otherChargesTotal > 0
          ? ([[labels.otherCharges, document.otherChargesTotal, false]] as Array<[string, number, boolean]>)
          : []),
      [labels.grandTotal, document.grandTotal, true],
    ];

    const boxWidth = 250;
    const boxX = pageRight - boxWidth;
    for (const [label, value, grand] of summaryRows) {
      if (y + 19 > doc.page.height - 36) {
        doc.addPage();
        y = drawPageBranding(false);
      }
      if (grand) {
        doc.rect(boxX, y, boxWidth, 19).fill("#1F3864");
        boldFont().fillColor("#ffffff").fontSize(9);
      } else {
        doc
          .moveTo(boxX, y + 18)
          .lineTo(pageRight, y + 18)
          .lineWidth(0.3)
          .strokeColor("#cccccc")
          .stroke();
        normalFont().fillColor("#000000").fontSize(8.5);
      }
      doc.text(label, boxX + 7, y + 5, { width: boxWidth * 0.58, align: textAlign, lineBreak: false });
      doc.text(money(value), boxX + boxWidth * 0.6, y + 5, {
        width: boxWidth * 0.37,
        align: "right",
        lineBreak: false,
      });
      y += 19;
    }
  }

  doc.end();
  const buffer = await completed;
  if (buffer.length < 5 || buffer.subarray(0, 4).toString("ascii") !== "%PDF") {
    throw new Error(FACTORY_INVOICE_EXTRA_LABELS.en.invalidPdf);
  }
  return { buffer, fileName: buildCanonicalInvoiceFilename(document, "pdf") };
}
