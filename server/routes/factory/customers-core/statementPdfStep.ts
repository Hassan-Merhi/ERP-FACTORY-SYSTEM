// Extracted from ./statement-pdf.ts: a stage of statement-pdf.
import { buildSafeFilename, contentDisposition } from "../../../lib/contentDisposition";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { customerOrders, customers, companies, companySettings } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { MoneyDecimal } from "../../../lib/money";
import { buildFactoryCustomerStatement } from "./statementRows";
import path from "path";
import fs from "fs";
import type { Request, Response } from "express";

export async function statementPdfStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };
  const customerId = parseInt(req.params.id);
  if (isNaN(customerId))
    return { done: true as const, value: res.status(400).json({ message: "Invalid customer ID" }) };

  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
  if (!customer) return { done: true as const, value: res.status(404).json({ message: "Customer not found" }) };

  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  const [settings] = await db.select().from(companySettings).where(eq(companySettings.companyId, companyId));

  // Ledger rows from the balance engine plus the amounts not yet in the
  // ledger, flagged (statementRows.ts); the closing is split below.
  const dateFromParam = ((req.query.dateFrom as string) || "").trim();
  const dateToParam = ((req.query.dateTo as string) || "").trim();
  const destFilterParam = ((req.query.destination as string) || "").trim().toLowerCase();
  const statement = await buildFactoryCustomerStatement(companyId, customerId, {
    from: dateFromParam || undefined,
    to: dateToParam || undefined,
  });
  const allRowsPdf = statement.rows.map((row) => ({
    transactionDate: row.transactionDate,
    transactionType: row.transactionType,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    description: row.description,
    rowNote: row.rowNote,
    notInLedger: row.notInLedger,
    combinedEffect: row.combinedEffect,
    ledgerEffect: row.ledgerEffect,
  }));
  const openingExact = statement.opening;

  // Filters are read before grouping so no charges cross period boundaries.

  // Build container number + destination maps for INVOICE-type rows
  const invoiceRefIds = [
    ...new Set(
      allRowsPdf.filter((r) => r.referenceType === "INVOICE" && r.referenceId).map((r) => r.referenceId as number)
    ),
  ];
  const containerNumMap = new Map<number, string>();
  const destinationMapPdf = new Map<number, string>();
  if (invoiceRefIds.length > 0) {
    const orderContainers = await db
      .select({
        id: customerOrders.id,
        containerNumber: customerOrders.containerNumber,
        destination: customerOrders.destination,
      })
      .from(customerOrders)
      .where(inArray(customerOrders.id, invoiceRefIds));
    for (const o of orderContainers) {
      if (o.containerNumber) containerNumMap.set(o.id, o.containerNumber);
      if (o.destination) destinationMapPdf.set(o.id, o.destination);
    }
  }

  // First pass: enrich ALL rows (needed before filtering)
  const allEnrichedPdf = allRowsPdf.map((row) => {
    const debit = row.combinedEffect.greaterThan(0) ? row.combinedEffect.toNumber() : 0;
    const credit = row.combinedEffect.lessThan(0) ? row.combinedEffect.negated().toNumber() : 0;
    let container = "";
    let particulars: string;
    if (row.referenceType === "INVOICE" && row.referenceId) {
      container = containerNumMap.get(row.referenceId) || "";
      particulars = destinationMapPdf.get(row.referenceId) || "";
    } else {
      particulars = row.description || "";
    }
    return { ...row, debit, credit, container, particulars };
  });

  // "Brought forward" balance at the start of the filter period
  let bfCombined = openingExact;
  if (dateFromParam) {
    for (const r of allEnrichedPdf) {
      const rDate = (r.transactionDate || "").toString().slice(0, 10);
      if (rDate >= dateFromParam) break;
      bfCombined = bfCombined.plus(r.combinedEffect);
    }
  }
  const bfRunning = bfCombined.toNumber();

  // Apply filters (mirrors frontend filteredHistory logic)
  const rows = allEnrichedPdf.filter((row) => {
    if (destFilterParam) {
      if (!(row.particulars || "").toLowerCase().includes(destFilterParam)) return false;
    }
    if (dateFromParam && row.transactionDate) {
      if ((row.transactionDate || "").toString().slice(0, 10) < dateFromParam) return false;
    }
    if (dateToParam && row.transactionDate) {
      if ((row.transactionDate || "").toString().slice(0, 10) > dateToParam) return false;
    }
    return true;
  });

  const totalDrExact = rows.reduce((sum, r) => sum.plus(MoneyDecimal.max(r.combinedEffect, 0)), new MoneyDecimal(0));
  const totalCrExact = rows.reduce(
    (sum, r) => sum.plus(MoneyDecimal.max(r.combinedEffect.negated(), 0)),
    new MoneyDecimal(0)
  );
  const totalDr = totalDrExact.toNumber();
  const totalCr = totalCrExact.toNumber();
  const closingCombined = bfCombined.plus(totalDrExact).minus(totalCrExact);
  const closingBalance = closingCombined.abs().toNumber();
  const closingBalanceSide: "Cr" | "Dr" = closingCombined.lessThan(0) ? "Cr" : "Dr";

  // Format: $1,234 (no .00 for whole numbers)
  const fmtAmt = (n: number) => {
    if (n <= 0) return "";
    const rounded = Math.round(n * 100) / 100;
    if (Math.abs(rounded - Math.round(rounded)) < 0.005) {
      return `$${Math.round(rounded).toLocaleString("en-US")}`;
    }
    return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const fmtBalance = (n: number, side: string) => {
    const rounded = Math.round(n * 100) / 100;
    const numStr =
      Math.abs(rounded - Math.round(rounded)) < 0.005
        ? `$${Math.round(rounded).toLocaleString("en-US")}`
        : `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `${numStr} ${side}`;
  };
  const fmtDate = (d: string) => {
    if (!d) return "";
    const [y, m, day] = d.split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${parseInt(day, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
  };
  const txLabel = (type: string) => {
    const map: Record<string, string> = {
      SALE: "Sale",
      PAYMENT: "Payment",
      RECEIPT: "Receipt",
      ADJUSTMENT: "Adjustment",
      JOURNAL: "Journal",
      OPENING_BALANCE: "Opening Bal.",
    };
    return map[type] || type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const PDFDocument = (await import("pdfkit")).default;
  const pathModCust = await import("path");

  // ── Arabic font ──
  const custFontDir = pathModCust.join(process.cwd(), "server", "fonts");
  const custArabicFontPath = pathModCust.join(custFontDir, "Amiri-Regular.ttf");
  const custHasArabicFont = fs.existsSync(custArabicFontPath);
  const custHmdLogoPath = path.join(process.cwd(), "server", "hmd-logo.png");

  // ── Fetch company logo — prefer companySettings.logoUrl, fall back to disk ──
  let logoBuffer: Buffer | null = null;
  const logoUrl = settings?.logoUrl as string | undefined;
  if (logoUrl) {
    try {
      logoBuffer = await new Promise<Buffer>((resolve, reject) => {
        const proto = logoUrl.startsWith("https") ? require("https") : require("http");
        proto
          .get(logoUrl, (r: import("http").IncomingMessage) => {
            const parts: Buffer[] = [];
            r.on("data", (d: Buffer) => parts.push(d));
            r.on("end", () => resolve(Buffer.concat(parts)));
            r.on("error", reject);
          })
          .on("error", reject);
      });
    } catch {
      logoBuffer = null;
    }
  }
  if (!logoBuffer && fs.existsSync(custHmdLogoPath)) {
    try {
      logoBuffer = fs.readFileSync(custHmdLogoPath);
    } catch {
      // Failure here is non-fatal and the surrounding flow continues deliberately.
    }
  }

  // ── PDF document ──
  const doc = new PDFDocument({ margin: 40, size: "A4", autoFirstPage: true });
  if (custHasArabicFont) doc.registerFont("Arabic", custArabicFontPath);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    contentDisposition(
      buildSafeFilename([customer.legalName || customer.code || String(customerId), getClientDate(req)], "pdf")
    )
  );
  doc.pipe(res);

  // ── Arabic reshaper ──
  let custConvAr: ((t: string) => string) | null = null;
  let custBidi: {
    getEmbeddingLevels: (t: string, d: string) => unknown;
    getReorderedString: (t: string, l: unknown) => string;
  } | null = null;
  try {
    custConvAr = require("arabic-reshaper").convertArabic;
    custBidi = require("bidi-js")();
  } catch {
    // Failure here is non-fatal and the surrounding flow continues deliberately.
  }
  const custHasAr = (t: string) => /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(t);

  return {
    done: false as const,
    customer,
    company,
    dateFromParam,
    dateToParam,
    destFilterParam,
    bfRunning,
    rows,
    totalDr,
    totalCr,
    closingBalance,
    closingBalanceSide,
    fmtAmt,
    fmtBalance,
    fmtDate,
    txLabel,
    custHasArabicFont,
    logoBuffer,
    doc,
    custConvAr,
    custBidi,
    custHasAr,
  };
}
