import ExcelJS from "exceljs";
import { toArrayBuffer } from "../../../lib/bufferCompatibility";
import { db } from "../../../db";

import {
  factoryBaleProducts,
  customerOrders,
  customerOrderLines,
  customerOrderCharges,
  customers,
  companies,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import path from "path";
import fs from "fs";

import { buildSafeFilename as buildExportFilename } from "../../../lib/contentDisposition";
export { buildExportFilename };

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: build the Commercial Invoice Excel workbook for an order and
// return it as a Buffer so it can be streamed to a browser download OR sent
// directly as a WhatsApp file attachment.
// ─────────────────────────────────────────────────────────────────────────────
export async function buildOrderExcelBuffer(
  orderId: number,
  companyId: number,
  hideSelling: boolean
): Promise<{ buffer: Buffer; fileName: string }> {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const [order] = await db
    .select({
      id: customerOrders.id,
      invoiceNumber: customerOrders.invoiceNumber,
      orderDate: customerOrders.orderDate,
      subtotalBales: customerOrders.subtotalBales,
      freightAmount: customerOrders.freightAmount,
      otherChargesTotal: customerOrders.otherChargesTotal,
      grandTotal: customerOrders.grandTotal,
      containerNumber: customerOrders.containerNumber,
      destination: customerOrders.destination,
      customerName: customers.legalName,
    })
    .from(customerOrders)
    .leftJoin(customers, eq(customerOrders.customerId, customers.id))
    .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));

  if (!order) throw new Error(`Order ${orderId} not found for company ${companyId}`);

  const orderChargesHelper = await db
    .select()
    .from(customerOrderCharges)
    .where(eq(customerOrderCharges.orderId, orderId));
  const rawLines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));

  const articleCodes = [...new Set(rawLines.map((l) => l.articleCode).filter(Boolean))];
  const productNameMap = new Map<string, string>();
  const wtPerBaleMap = new Map<string, number>();
  if (articleCodes.length > 0) {
    const products = await db
      .select({
        articleCode: factoryBaleProducts.articleCode,
        name: factoryBaleProducts.name,
        weightPerBaleKg: factoryBaleProducts.weightPerBaleKg,
      })
      .from(factoryBaleProducts)
      .where(and(eq(factoryBaleProducts.companyId, companyId), inArray(factoryBaleProducts.articleCode, articleCodes)));
    for (const p of products) {
      if (p.articleCode) {
        productNameMap.set(p.articleCode, p.name);
        wtPerBaleMap.set(p.articleCode, parseFloat(p.weightPerBaleKg || "0"));
      }
    }
  }

  const helperLines = rawLines
    .map((l) => ({
      articleCode: l.articleCode || "",
      productName: productNameMap.get(l.articleCode) || l.baleName || l.articleCode || "",
      qty: parseInt(String(l.qty || "0"), 10),
      wtPerBale: wtPerBaleMap.get(l.articleCode) || parseFloat(l.weightPerBale || "0"),
      totalWt: parseFloat(l.totalWeight || "0"),
      pricePerBale: parseFloat(l.pricePerBale || "0"),
      total: parseFloat(l.totalPrice || "0"),
      pricingMode: (l.pricingMode as string) || "per_bale",
      pricePerKg: parseFloat(l.pricePerKg || "0"),
    }))
    .sort((a, b) => a.articleCode.localeCompare(b.articleCode));
  const anyPerKgH = helperLines.some((l) => l.pricingMode === "per_kg");

  const baseCurrency = company?.baseCurrency || "USD";
  const currencySymbolMap: Record<string, string> = {
    USD: "$",
    GBP: "£",
    EUR: "€",
    CFA: "CFA",
    XOF: "CFA",
    XAF: "CFA",
  };
  const currSym = currencySymbolMap[baseCurrency.toUpperCase()] ?? baseCurrency;
  const fmtMoney = (n: number) => `${currSym}${n % 1 === 0 ? n.toLocaleString() : n.toFixed(2)}`;
  const fmtNum = (n: number) => (n % 1 === 0 ? n.toLocaleString() : n.toFixed(2));

  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Commercial Invoice");
  const COL = 8;

  sheet.columns = [
    { key: "c1", width: 6 },
    { key: "c2", width: 16 },
    { key: "c3", width: 30 },
    { key: "c4", width: 8 },
    { key: "c5", width: 11 },
    { key: "c6", width: 13 },
    { key: "c7", width: 13 },
    { key: "c8", width: 14 },
  ];

  const DARK_BLUE = "FF1F3864";
  const LIGHT_GRAY = "FFF5F5F5";
  const WHITE = "FFFFFFFF";

  const merge = (r: number, c1: number, c2: number) => sheet.mergeCells(r, c1, r, c2);
  const setFill = (cell: ExcelJS.Cell, argb: string) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  };
  const setBorderH = (row: ExcelJS.Row) => {
    row.eachCell((cell: ExcelJS.Cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFDDDDDD" } },
        bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
        left: { style: "thin", color: { argb: "FFDDDDDD" } },
        right: { style: "thin", color: { argb: "FFDDDDDD" } },
      };
    });
  };

  // Logo
  const logoRow = sheet.addRow([]);
  logoRow.height = 110;
  try {
    const logoPath = path.join(process.cwd(), "server", "hmd-logo.png");
    if (fs.existsSync(logoPath)) {
      const logoBuf = fs.readFileSync(logoPath);
      const logoId = workbook.addImage({ buffer: toArrayBuffer(logoBuf), extension: "jpeg" });
      sheet.addImage(logoId, { tl: { col: 0, row: 0 }, ext: { width: 180, height: 110 } });
    }
  } catch {
    // Failure here is non-fatal and the surrounding flow continues deliberately.
  }

  const r1 = sheet.addRow(["HMD INTERNATIONAL GROUP"]);
  r1.height = 26;
  r1.getCell(1).font = { bold: true, size: 16, color: { argb: DARK_BLUE } };
  r1.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  merge(r1.number, 1, COL);

  const r2 = sheet.addRow(["Commercial Invoice"]);
  r2.height = 22;
  r2.getCell(1).font = { bold: true, size: 14, color: { argb: DARK_BLUE } };
  r2.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  merge(r2.number, 1, COL);
  sheet.addRow([]);

  const invoiceNum = order.invoiceNumber || `INV-${String(orderId).padStart(6, "0")}`;
  const orderDateFmt = order.orderDate
    ? new Date(order.orderDate).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" })
    : "-";

  for (const [label, value] of [
    ["Invoice No.", invoiceNum],
    ["Customer", order.customerName || "-"],
    ["Date", orderDateFmt],
    ["Container", order.containerNumber || "-"],
  ]) {
    const dr = sheet.addRow(["", "", "", "", "", label, "", value]);
    dr.height = 20;
    dr.getCell(6).font = { bold: true, size: 11 };
    dr.getCell(6).alignment = { horizontal: "right" };
    dr.getCell(8).font = { size: 11 };
    dr.getCell(8).alignment = { horizontal: "left" };
    merge(dr.number, 6, 7);
  }
  sheet.addRow([]);

  const unitPriceLabelH = anyPerKgH ? "Price/KG" : "Price/Bale";
  const hdrRow = sheet.addRow([
    "#",
    "Article Code",
    "Product",
    "Qty",
    "Wt/Bale",
    "Total Wt",
    ...(hideSelling ? [] : [unitPriceLabelH, "Total"]),
  ]);
  hdrRow.height = 24;
  hdrRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
    setFill(cell, DARK_BLUE);
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      top: { style: "thin", color: { argb: WHITE } },
      bottom: { style: "thin", color: { argb: WHITE } },
      left: { style: "thin", color: { argb: WHITE } },
      right: { style: "thin", color: { argb: WHITE } },
    };
  });

  let totalQtyH = 0,
    totalWtH = 0,
    totalH = 0;
  helperLines.forEach((g, idx: number) => {
    totalQtyH += g.qty;
    totalWtH += g.totalWt;
    totalH += g.total;
    const unitPriceH =
      g.pricingMode === "per_kg" ? (g.totalWt > 0 ? g.total / g.totalWt : g.pricePerKg || 0) : g.pricePerBale;
    const rowCells = [idx + 1, g.articleCode, g.productName, g.qty, fmtNum(g.wtPerBale), fmtNum(g.totalWt)];
    if (!hideSelling) {
      rowCells.push(fmtMoney(unitPriceH));
      rowCells.push(fmtMoney(g.total));
    }
    const dr = sheet.addRow(rowCells);
    dr.height = 20;
    dr.eachCell((cell) => {
      cell.font = { size: 11 };
    });
    if (idx % 2 === 1) dr.eachCell((cell) => setFill(cell, LIGHT_GRAY));
    dr.getCell(1).alignment = { horizontal: "center" };
    dr.getCell(4).alignment = { horizontal: "right" };
    dr.getCell(5).alignment = { horizontal: "right" };
    dr.getCell(6).alignment = { horizontal: "right" };
    if (!hideSelling) {
      dr.getCell(7).alignment = { horizontal: "right" };
      dr.getCell(8).alignment = { horizontal: "right" };
    }
    setBorderH(dr);
  });

  const totRowCells = ["", "", "Totals", totalQtyH, "", fmtNum(totalWtH)];
  if (!hideSelling) {
    totRowCells.push("");
    totRowCells.push(fmtMoney(totalH));
  }
  const totRow = sheet.addRow(totRowCells);
  totRow.height = 22;
  totRow.eachCell((cell) => {
    cell.font = { bold: true, size: 11, color: { argb: WHITE } };
    setFill(cell, DARK_BLUE);
    cell.alignment = { horizontal: "right" };
  });
  totRow.getCell(3).alignment = { horizontal: "center" };
  sheet.addRow([]);

  if (!hideSelling) {
    const subtotal = parseFloat(order.subtotalBales || "0");
    const freight = parseFloat(order.freightAmount || "0");
    const otherChargesTotal = parseFloat(order.otherChargesTotal || "0");
    const grandTotal = parseFloat(order.grandTotal || "0");

    const otherChargeLines = orderChargesHelper.filter((ch) => ch.chargeType !== "FREIGHT");
    const chargeRows: [string, number][] =
      otherChargeLines.length > 0
        ? otherChargeLines.map((ch) => [ch.name, parseFloat(ch.amount || "0")] as [string, number])
        : otherChargesTotal > 0
          ? [["Other Charges", otherChargesTotal]]
          : [];

    const summaryData: [string, number][] = [
      ["Subtotal (Bales)", subtotal],
      ...(freight > 0 ? [["Freight", freight] as [string, number]] : []),
      ...chargeRows,
      ["Grand Total", grandTotal],
    ];

    const sumHdr = sheet.addRow(["", "", "", "", "", "", "Name", "Amount"]);
    sumHdr.height = 22;
    sumHdr.getCell(7).font = { bold: true, color: { argb: WHITE }, size: 11 };
    sumHdr.getCell(8).font = { bold: true, color: { argb: WHITE }, size: 11 };
    setFill(sumHdr.getCell(7), DARK_BLUE);
    setFill(sumHdr.getCell(8), DARK_BLUE);
    sumHdr.getCell(7).alignment = { horizontal: "center" };
    sumHdr.getCell(8).alignment = { horizontal: "center" };

    summaryData.forEach(([label, amount], idx) => {
      const sr = sheet.addRow(["", "", "", "", "", "", label, fmtMoney(amount)]);
      sr.height = 20;
      const isGrandTotal = idx === summaryData.length - 1;
      const bg = isGrandTotal ? DARK_BLUE : idx % 2 === 0 ? WHITE : LIGHT_GRAY;
      const fg = isGrandTotal ? WHITE : "FF000000";
      setFill(sr.getCell(7), bg);
      setFill(sr.getCell(8), bg);
      sr.getCell(7).font = { bold: isGrandTotal, size: 11, color: { argb: fg } };
      sr.getCell(8).font = { bold: isGrandTotal, size: 11, color: { argb: fg } };
      sr.getCell(7).alignment = { horizontal: "left" };
      sr.getCell(8).alignment = { horizontal: "right" };
      sr.getCell(7).border = {
        top: { style: "thin", color: { argb: "FFDDDDDD" } },
        bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
        left: { style: "thin", color: { argb: "FFDDDDDD" } },
        right: { style: "thin", color: { argb: "FFDDDDDD" } },
      };
      sr.getCell(8).border = {
        top: { style: "thin", color: { argb: "FFDDDDDD" } },
        bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
        left: { style: "thin", color: { argb: "FFDDDDDD" } },
        right: { style: "thin", color: { argb: "FFDDDDDD" } },
      };
    });
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileName = buildExportFilename([order.containerNumber, order.customerName, order.destination], "xlsx");
  return { buffer, fileName };
}
