import type { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";
import {
  companies,
  customerOrderBales,
  customerOrderCharges,
  customerOrderLines,
  customerOrders,
  customers,
  factoryBales,
} from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getExportPriceVisibility } from "../../helpers/exportVisibility";
import { buildSafeFilename, contentDisposition } from "../../lib/contentDisposition";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { writeAuditEvent } from "../../services/audit/auditService";
import {
  FACTORY_DOCUMENT_LABELS,
  applyFactoryPdfLanguage,
  configureFactoryArabicWorksheet,
  isArabicFactoryDocument,
  parseFactoryDocumentLanguage,
  resolveFactoryDocumentProductName,
  translateFactoryDocumentStatus,
} from "../../services/factoryDocumentLanguage";

function companyIdFrom(req: Request): number | null {
  const value = Number(req.session?.factoryCompanyId ?? req.session?.currentCompanyId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function orderIdFrom(req: Request): number | null {
  const value = Number(req.params.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hasExplicitLanguage(req: Request): boolean {
  return req.query.lang === "en" || req.query.lang === "ar";
}

async function loadOrder(orderId: number, companyId: number) {
  const [order] = await db
    .select({
      id: customerOrders.id,
      invoiceNumber: customerOrders.invoiceNumber,
      orderDate: customerOrders.orderDate,
      status: customerOrders.status,
      subtotalBales: customerOrders.subtotalBales,
      freightAmount: customerOrders.freightAmount,
      otherChargesTotal: customerOrders.otherChargesTotal,
      grandTotal: customerOrders.grandTotal,
      totalQtyBales: customerOrders.totalQtyBales,
      containerNumber: customerOrders.containerNumber,
      destination: customerOrders.destination,
      customerName: customers.legalName,
      customerCode: customers.code,
      baseCurrency: companies.baseCurrency,
    })
    .from(customerOrders)
    .leftJoin(customers, eq(customers.id, customerOrders.customerId))
    .leftJoin(companies, eq(companies.id, customerOrders.companyId))
    .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
    .limit(1);
  if (!order) return null;
  const lines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));
  const charges = await db.select().from(customerOrderCharges).where(eq(customerOrderCharges.orderId, orderId));
  return { order, lines, charges };
}

function currencySymbol(currency: unknown): string {
  const code = String(currency || "USD").toUpperCase();
  return ({ USD: "$", EUR: "€", GBP: "£", XOF: "CFA", XAF: "CFA", CFA: "CFA" } as Record<string, string>)[code] ?? code;
}

function safeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function auditExport(req: Request, companyId: number, orderId: number, format: string, language: string) {
  await writeAuditEvent({
    action: "factory_bilingual_document_export",
    entityType: "customer_order",
    entityId: orderId,
    companyId,
    userId: Number(req.session?.userId) || undefined,
    metadata: {
      format,
      language,
      noCharges: req.query.noCharges === "1",
    },
  });
}

async function sendInvoiceExcel(req: Request, res: Response, data: NonNullable<Awaited<ReturnType<typeof loadOrder>>>) {
  const language = parseFactoryDocumentLanguage(req.query.lang);
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const { hideSelling } = await getExportPriceVisibility(req);
  const noCharges = req.query.noCharges === "1";
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const title = labels.commercialInvoice;
  const sheet = workbook.addWorksheet(title.slice(0, 31), {
    views: isArabicFactoryDocument(language) ? [{ rightToLeft: true }] : undefined,
  });
  sheet.columns = [
    { width: 6 },
    { width: 18 },
    { width: 34 },
    { width: 11 },
    { width: 13 },
    { width: 15 },
    { width: 15 },
    { width: 16 },
  ];

  const titleRow = sheet.addRow([title]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 8);
  titleRow.font = { bold: true, size: 16 };
  titleRow.alignment = { horizontal: "center", readingOrder: language === "ar" ? "rtl" : "ltr" };

  const invoiceNumber = data.order.invoiceNumber || `INV-${String(data.order.id).padStart(6, "0")}`;
  const metadata: Array<[string, string]> = [
    [labels.invoiceNo, invoiceNumber],
    [labels.customer, data.order.customerName || "-"],
    [labels.date, data.order.orderDate ? String(data.order.orderDate) : "-"],
    [labels.container, data.order.containerNumber || "-"],
    [labels.destination, data.order.destination || "-"],
    [labels.status, translateFactoryDocumentStatus(data.order.status, language)],
  ];
  for (const [label, value] of metadata) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    sheet.mergeCells(row.number, 2, row.number, 8);
  }
  sheet.addRow([]);

  const hasPerKg = data.lines.some((line) => line.pricingMode === "per_kg");
  const headers = [
    "#",
    labels.articleCode,
    labels.product,
    labels.quantity,
    labels.weightPerBale,
    labels.totalWeight,
    ...(hideSelling ? [] : [hasPerKg ? labels.pricePerKg : labels.pricePerBale, labels.total]),
  ];
  const header = sheet.addRow(headers);
  header.font = { bold: true };

  let qtyTotal = 0;
  let weightTotal = 0;
  let lineTotal = 0;
  data.lines.forEach((line, index: number) => {
    const qty = safeNumber(line.qty);
    const totalWeight = safeNumber(line.totalWeight);
    const totalPrice = safeNumber(line.totalPrice);
    const price = line.pricingMode === "per_kg" ? safeNumber(line.pricePerKg) : safeNumber(line.pricePerBale);
    qtyTotal += qty;
    weightTotal += totalWeight;
    lineTotal += totalPrice;
    const values: unknown[] = [
      index + 1,
      line.articleCode || "",
      resolveFactoryDocumentProductName(line, language),
      qty,
      safeNumber(line.weightPerBale),
      totalWeight,
    ];
    if (!hideSelling) values.push(price, totalPrice);
    const row = sheet.addRow(values);
    row.getCell(4).numFmt = "#,##0";
    row.getCell(5).numFmt = "#,##0.00";
    row.getCell(6).numFmt = "#,##0.00";
    if (!hideSelling) {
      row.getCell(7).numFmt = "#,##0.00";
      row.getCell(8).numFmt = "#,##0.00";
    }
  });

  const totals: unknown[] = ["", "", labels.totals, qtyTotal, "", weightTotal];
  if (!hideSelling) totals.push("", lineTotal);
  const totalRow = sheet.addRow(totals);
  totalRow.font = { bold: true };
  totalRow.getCell(6).numFmt = "#,##0.00";
  if (!hideSelling) totalRow.getCell(8).numFmt = "#,##0.00";

  if (!hideSelling && !noCharges) {
    sheet.addRow([]);
    const money = currencySymbol(data.order.baseCurrency);
    for (const [label, amount] of [
      [labels.subtotal, safeNumber(data.order.subtotalBales)],
      [labels.freight, safeNumber(data.order.freightAmount)],
      [labels.otherCharges, safeNumber(data.order.otherChargesTotal)],
      [labels.grandTotal, safeNumber(data.order.grandTotal)],
    ] as Array<[string, number]>) {
      const row = sheet.addRow(["", "", "", "", "", label, money, amount]);
      row.getCell(6).font = { bold: true };
      row.getCell(8).numFmt = "#,##0.00";
    }
    for (const charge of data.charges) {
      const row = sheet.addRow([
        "",
        "",
        "",
        "",
        "",
        charge.name || labels.otherCharges,
        money,
        safeNumber(charge.amount),
      ]);
      row.getCell(8).numFmt = "#,##0.00";
    }
  }

  configureFactoryArabicWorksheet(sheet, language);
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileName = buildSafeFilename([invoiceNumber, language], "xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", contentDisposition(fileName));
  res.setHeader("Content-Length", buffer.byteLength);
  res.end(buffer);
}

async function sendInvoicePdf(req: Request, res: Response, data: NonNullable<Awaited<ReturnType<typeof loadOrder>>>) {
  const language = parseFactoryDocumentLanguage(req.query.lang);
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const { hideSelling } = await getExportPriceVisibility(req);
  const noCharges = req.query.noCharges === "1";
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ margin: 36, size: "A4" });
  applyFactoryPdfLanguage(doc, language);
  const invoiceNumber = data.order.invoiceNumber || `INV-${String(data.order.id).padStart(6, "0")}`;
  const fileName = buildSafeFilename([invoiceNumber, language], "pdf");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", contentDisposition(fileName));
  doc.pipe(res);

  const rtl = language === "ar";
  const align = rtl ? "right" : "left";
  const pageWidth = doc.page.width - 72;
  const logo = path.join(process.cwd(), "server", "hmd-logo.png");
  if (fs.existsSync(logo)) {
    try {
      doc.image(logo, (doc.page.width - 180) / 2, 24, { width: 180 });
    } catch {
      // Failure here is non-fatal and the surrounding flow continues deliberately.
    }
  }
  doc.moveDown(5);
  doc.fontSize(16).text(labels.invoice, 36, doc.y, { width: pageWidth, align: "center" });
  doc.moveDown();
  const meta: Array<[string, string]> = [
    [labels.invoiceNo, invoiceNumber],
    [labels.customer, data.order.customerName || "-"],
    [labels.date, data.order.orderDate ? String(data.order.orderDate) : "-"],
    [labels.container, data.order.containerNumber || "-"],
    [labels.destination, data.order.destination || "-"],
    [labels.status, translateFactoryDocumentStatus(data.order.status, language)],
  ];
  doc.fontSize(10);
  for (const [label, value] of meta) {
    doc.text(`${label}: ${value}`, { align, width: pageWidth });
  }
  doc.moveDown();

  const col = { code: 36, name: 130, qty: 330, weight: 375, price: 455, total: 515 };
  const headerY = doc.y;
  doc.fontSize(9).text(labels.articleCode, col.code, headerY, { width: 88, align });
  doc.text(labels.product, col.name, headerY, { width: 195, align });
  doc.text(labels.quantity, col.qty, headerY, { width: 40, align: "right" });
  doc.text(labels.totalWeight, col.weight, headerY, { width: 70, align: "right" });
  if (!hideSelling) {
    doc.text(labels.pricePerBale, col.price, headerY, { width: 55, align: "right" });
    doc.text(labels.total, col.total, headerY, { width: 45, align: "right" });
  }
  doc.moveDown(1.2);
  let totalQty = 0;
  let totalWeight = 0;
  let totalAmount = 0;
  for (const line of (data.lines)) {
    if (doc.y > 730) doc.addPage();
    const y = doc.y;
    const qty = safeNumber(line.qty);
    const weight = safeNumber(line.totalWeight);
    const amount = safeNumber(line.totalPrice);
    totalQty += qty;
    totalWeight += weight;
    totalAmount += amount;
    doc.text(line.articleCode || "", col.code, y, { width: 88, align });
    doc.text(resolveFactoryDocumentProductName(line, language), col.name, y, { width: 195, align });
    doc.text(String(qty), col.qty, y, { width: 40, align: "right" });
    doc.text(weight.toFixed(2), col.weight, y, { width: 70, align: "right" });
    if (!hideSelling) {
      const price = line.pricingMode === "per_kg" ? safeNumber(line.pricePerKg) : safeNumber(line.pricePerBale);
      doc.text(price.toFixed(2), col.price, y, { width: 55, align: "right" });
      doc.text(amount.toFixed(2), col.total, y, { width: 45, align: "right" });
    }
    doc.moveDown(1.2);
  }
  doc.moveDown(0.5);
  doc
    .fontSize(10)
    .text(
      `${labels.totals}: ${totalQty} | ${totalWeight.toFixed(2)} kg${hideSelling ? "" : ` | ${totalAmount.toFixed(2)}`}`,
      { align }
    );
  if (!hideSelling && !noCharges) {
    doc.text(`${labels.subtotal}: ${safeNumber(data.order.subtotalBales).toFixed(2)}`, { align });
    doc.text(`${labels.freight}: ${safeNumber(data.order.freightAmount).toFixed(2)}`, { align });
    doc.text(`${labels.otherCharges}: ${safeNumber(data.order.otherChargesTotal).toFixed(2)}`, { align });
    doc.fontSize(11).text(`${labels.grandTotal}: ${safeNumber(data.order.grandTotal).toFixed(2)}`, { align });
  }
  doc.end();
}

async function _loadBales(orderId: number) {
  const links = await db
    .select()
    .from(customerOrderBales)
    .where(eq(customerOrderBales.orderId, orderId))
    .orderBy(customerOrderBales.id);
  const rows = await db.select().from(factoryBales).where(eq(factoryBales.companyId, -1));
  const map = new Map<number, unknown>(rows.map((row) => [row.id, row]));
  return { links, map };
}

async function sendLoadingExcel(req: Request, res: Response, data: NonNullable<Awaited<ReturnType<typeof loadOrder>>>) {
  const language = parseFactoryDocumentLanguage(req.query.lang);
  const labels = FACTORY_DOCUMENT_LABELS[language];
  const links = await db
    .select()
    .from(customerOrderBales)
    .where(eq(customerOrderBales.orderId, data.order.id))
    .orderBy(customerOrderBales.id);
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(labels.loadingList.slice(0, 31), {
    views: isArabicFactoryDocument(language) ? [{ rightToLeft: true }] : undefined,
  });
  sheet.columns = [{ width: 7 }, { width: 22 }, { width: 18 }, { width: 36 }, { width: 16 }, { width: 20 }];
  const title = sheet.addRow([`${labels.loadingList} — ${data.order.customerName || ""}`]);
  sheet.mergeCells(title.number, 1, title.number, 6);
  title.font = { bold: true, size: 14 };
  title.alignment = { horizontal: "center", readingOrder: language === "ar" ? "rtl" : "ltr" };
  const header = sheet.addRow([
    "#",
    labels.reference,
    labels.articleCode,
    labels.product,
    labels.weightKg,
    labels.cumulativeWeight,
  ]);
  header.font = { bold: true };
  let cumulative = 0;
  links.forEach((link, index: number) => {
    const weight = safeNumber(link.weight);
    cumulative += weight;
    const row = sheet.addRow([
      index + 1,
      link.baleReference || "",
      link.articleCode || "",
      resolveFactoryDocumentProductName(link, language),
      weight,
      cumulative,
    ]);
    row.getCell(5).numFmt = "#,##0.00";
    row.getCell(6).numFmt = "#,##0.00";
  });
  const total = sheet.addRow(["", "", "", labels.total, cumulative, cumulative]);
  total.font = { bold: true };
  total.getCell(5).numFmt = "#,##0.00";
  total.getCell(6).numFmt = "#,##0.00";
  configureFactoryArabicWorksheet(sheet, language);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const fileName = buildSafeFilename(["loading", data.order.invoiceNumber || data.order.id, language], "xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", contentDisposition(fileName));
  res.setHeader("Content-Length", buffer.byteLength);
  res.end(buffer);
}

export function registerFactoryBilingualDocumentRoutes(app: Express): void {
  const invoiceHandler = (format: "pdf" | "excel") => async (req: Request, res: Response, next: import("express").NextFunction) => {
    if (!hasExplicitLanguage(req)) return next();
    try {
      const companyId = companyIdFrom(req);
      const orderId = orderIdFrom(req);
      if (!companyId) return res.status(403).json({ message: "Factory company access required" });
      if (!orderId) return res.status(400).json({ message: "Invalid order ID" });
      const data = await loadOrder(orderId, companyId);
      if (!data) return res.status(404).json({ message: "Order not found" });
      if (format === "pdf") await sendInvoicePdf(req, res, data);
      else await sendInvoiceExcel(req, res, data);
      await auditExport(req, companyId, orderId, format, String(req.query.lang));
    } catch (error) {
      logger.error("Factory bilingual invoice export failed", { error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  };

  const loadingHandler = async (req: Request, res: Response, next: import("express").NextFunction) => {
    if (!hasExplicitLanguage(req)) return next();
    try {
      const companyId = companyIdFrom(req);
      const orderId = orderIdFrom(req);
      if (!companyId) return res.status(403).json({ message: "Factory company access required" });
      if (!orderId) return res.status(400).json({ message: "Invalid order ID" });
      const data = await loadOrder(orderId, companyId);
      if (!data) return res.status(404).json({ message: "Order not found" });
      await sendLoadingExcel(req, res, data);
      await auditExport(req, companyId, orderId, "loading-xlsx", String(req.query.lang));
    } catch (error) {
      logger.error("Factory bilingual loading export failed", { error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  };

  app.get("/api/factory/customer-orders/:id/export-pdf", requireAuth, invoiceHandler("pdf"));
  app.get("/api/factory/customer-orders/:id/export/excel", requireAuth, invoiceHandler("excel"));
  app.get("/api/factory/customer-orders/:id/export-excel", requireAuth, invoiceHandler("excel"));
  app.get("/api/factory/customer-orders/:id/pending-export", requireAuth, loadingHandler);
  app.get("/api/factory/customer-orders/:id/loading-list", requireAuth, loadingHandler);
}
