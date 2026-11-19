// Extracted from ./factoryInvoiceDocumentService.ts to keep that module under the source-size cap.
import { configureFactoryArabicWorksheet, FACTORY_DOCUMENT_LABELS } from "./factoryDocumentLanguage";
import { FACTORY_INVOICE_EXTRA_LABELS } from "./factoryInvoiceTranslations";
import { type CanonicalInvoiceDocument, type InvoiceRenderOptions } from "./factoryInvoiceDocumentModel";
import { buildInvoiceRenderGroups, localizedLineCategory, localizedLineProduct } from "./factoryInvoiceRenderGroups";
import { styleSpecializedWorkbook } from "@shared/universal-excel/specializedWorkbookStyle";
import { excelMoneyFormat, buildCanonicalInvoiceFilename, unitPriceLabel } from "./buildCanonicalInvoiceExcelHelpers";
export {
  currencySymbol,
  getCanonicalInvoiceDocument,
  freezeCanonicalInvoiceDocument,
  buildCanonicalInvoiceFilename,
  unitPriceLabel,
  concatBuffers,
} from "./buildCanonicalInvoiceExcelHelpers";

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
  // Preserve canonical invoice source, localized headers, print totals and
  // existing HMD logo. No accounting or order recalculations in this adapter.
  styleSpecializedWorkbook(workbook, {
    expectedSheetNames: [sheet.name],
    sheets: [{ name: sheet.name, purpose: "report" }],
  });
  const raw = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw as ArrayBuffer);
  if (buffer.length < 2 || buffer.subarray(0, 2).toString("ascii") !== "PK") {
    throw new Error(FACTORY_INVOICE_EXTRA_LABELS.en.invalidWorkbook);
  }
  return { buffer, fileName: buildCanonicalInvoiceFilename(document, "xlsx") };
}
