import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import {
  companies,
  customerOrderBales,
  customerOrderCharges,
  customerOrderLines,
  customerOrders,
  customers,
} from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getExportPriceVisibility } from "../../helpers/exportVisibility";
import { buildSafeFilename, contentDisposition } from "../../lib/contentDisposition";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { writeAuditEvent } from "../../services/audit/auditService";
import {
  buildCanonicalInvoiceExcel,
  buildCanonicalInvoicePdf,
  getCanonicalInvoiceDocument,
} from "../../services/factoryInvoiceDocumentService";
import {
  FACTORY_DOCUMENT_LABELS,
  configureFactoryArabicWorksheet,
  isArabicFactoryDocument,
  parseFactoryDocumentLanguage,
  resolveFactoryDocumentProductName,
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
      const document = await getCanonicalInvoiceDocument(orderId, companyId);
      if (!document) return res.status(404).json({ message: "Order not found" });
      const language = parseFactoryDocumentLanguage(req.query.lang);
      const { hideSelling } = await getExportPriceVisibility(req);
      const noCharges = req.query.noCharges === "1";
      const rendered =
        format === "pdf"
          ? await buildCanonicalInvoicePdf(document, { hideSelling, noCharges, language })
          : await buildCanonicalInvoiceExcel(document, { hideSelling, noCharges, language });
      res.status(200);
      res.setHeader(
        "Content-Type",
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", contentDisposition(rendered.fileName));
      res.setHeader("Content-Length", String(rendered.buffer.length));
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(rendered.buffer);
      await auditExport(req, companyId, orderId, format, language);
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
