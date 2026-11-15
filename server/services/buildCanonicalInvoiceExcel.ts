// Extracted from ./factoryInvoiceDocumentService.ts to keep that module under the source-size cap.
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { buildSafeFilename } from "../lib/contentDisposition";
import {
  configureFactoryArabicWorksheet,
  FACTORY_DOCUMENT_LABELS,
  type FactoryDocumentLanguage,
} from "./factoryDocumentLanguage";
import { FACTORY_INVOICE_EXTRA_LABELS } from "./factoryInvoiceTranslations";
import {
  type CanonicalInvoiceDocument,
  type InvoiceRenderOptions,
  resultRows,
  safeString,
} from "./factoryInvoiceDocumentModel";
import { buildLiveCanonicalInvoiceDocument } from "./factoryInvoiceDocumentSource";
import { buildInvoiceRenderGroups, localizedLineCategory, localizedLineProduct } from "./factoryInvoiceRenderGroups";

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

export function unitPriceLabel(document: CanonicalInvoiceDocument, language: FactoryDocumentLanguage): string {
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
  const SUBTOTAL_BLUE = "FF2F75B5";
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
    ...(document.dispatchTrips?.length
      ? [
          [
            "Dispatch trips",
            document.dispatchTrips.map((t) => "#" + String(t.dispatchNumber).padStart(3, "0")).join(", "),
          ] as [string, string],
        ]
      : []),
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
    // Style every cell, including the blank cells, as one continuous blue subtotal band.
    for (let column = 1; column <= COL; column += 1) {
      const cell = subtotalRow.getCell(column);
      cell.font = { bold: true, size: 10, color: { argb: WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SUBTOTAL_BLUE } };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: WHITE } },
        bottom: { style: "thin", color: { argb: WHITE } },
        left: { style: "thin", color: { argb: "FF9EC3E1" } },
        right: { style: "thin", color: { argb: "FF9EC3E1" } },
      };
    }
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

export function concatBuffers(chunks: Buffer[]): Buffer {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  for (const chunk of chunks) {
    chunk.copy(output, offset);
    offset += chunk.length;
  }
  return output;
}
