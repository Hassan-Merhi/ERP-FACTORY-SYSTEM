/**
 * Shared account statement PDF generator.
 * Used by both the "Export PDF" route and the WhatsApp auto-send feature.
 * Returns a Buffer so callers can either pipe it to a Response or send it to WhatsApp.
 *
 * Layout: 5 columns — DATE | PARTICULARS | DEBIT | CREDIT | BALANCE
 */

import { db } from "../db";
import { storage } from "../storage";
import { ledgerAccounts, bankAccounts, fixedAssets, customers, employees } from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { eq, and } from "drizzle-orm";
import type Decimal from "decimal.js";
import { sumMoney, toMoney } from "./money";
import { getCustomerByLedgerId } from "./factoryCustomerLedger";
import { getPartyBalance } from "../services/accounting/balances/ledgerBalanceEngine";
import { loadCustomerLedgerLines } from "../services/accounting/balances/customerLedgerStatement";

/** The account is not a master of this company (wave 18 C): the route answers 404. */
export class StatementAccountNotFoundError extends Error {
  readonly status = 404;
  constructor(accountType: string, accountId: number) {
    super(`Account not found: ${accountType} ${accountId}`);
    this.name = "StatementAccountNotFoundError";
  }
}

export interface StatementPdfOptions {
  accountType: string;
  accountId: number;
  companyId: number;
  startDate?: string;
  endDate?: string;
  lang?: string;
}

/**
 * The common shape of every source feeding the statement table: voucher-entry
 * statement rows, factory customer ledger entries, and customer-balance rows
 * mapped in this module. Amount columns are numeric-as-text; nullable text
 * columns fall back to "" at render time exactly as they did before.
 */
interface StatementSourceEntry {
  voucherId: number;
  voucherNumber: string | null;
  voucherType: string | null;
  voucherDate: string | null;
  voucherDescription: string | null;
  narration: string | null;
  debitAmount: string | null;
  creditAmount: string | null;
}

/** The customer's ledger lines (balance engine rules) as statement rows. */
async function customerStatementEntries(
  companyId: number,
  customerId: number,
  startDate: string | undefined,
  endDate: string | undefined
): Promise<StatementSourceEntry[]> {
  return loadCustomerLedgerLines(db, { companyId, customerId, from: startDate ?? null, to: endDate ?? null });
}

export async function generateAccountStatementPdf(opts: StatementPdfOptions): Promise<Buffer> {
  const { accountType, accountId, companyId, startDate, endDate, lang = "en" } = opts;

  const translations: Record<
    string,
    {
      accountStatement: string;
      period: string;
      generated: string;
      colDate: string;
      colParticulars: string;
      colDebit: string;
      colCredit: string;
      colBalance: string;
      openingBalance: string;
      periodTotal: string;
      closingBalance: string;
      from: string;
      upTo: string;
      allTime: string;
      dr: string;
      cr: string;
    }
  > = {
    en: {
      accountStatement: "Account Statement",
      period: "Period",
      generated: "Generated",
      colDate: "DATE",
      colParticulars: "PARTICULARS",
      colDebit: "DEBIT",
      colCredit: "CREDIT",
      colBalance: "BALANCE",
      openingBalance: "Opening Balance",
      periodTotal: "Current Period Total",
      closingBalance: "Closing Balance",
      from: "From",
      upTo: "Up to",
      allTime: "All Time",
      dr: "Dr",
      cr: "Cr",
    },
    fr: {
      accountStatement: "Relevé de compte",
      period: "Période",
      generated: "Généré le",
      colDate: "DATE",
      colParticulars: "LIBELLÉ",
      colDebit: "DÉBIT",
      colCredit: "CRÉDIT",
      colBalance: "SOLDE",
      openingBalance: "Solde d'ouverture",
      periodTotal: "Total de la période",
      closingBalance: "Solde de clôture",
      from: "Du",
      upTo: "Au",
      allTime: "Toute la période",
      dr: "Dt",
      cr: "Ct",
    },
    ar: {
      accountStatement: "كشف حساب",
      period: "الفترة",
      generated: "تاريخ الإنشاء",
      colDate: "التاريخ",
      colParticulars: "البيان",
      colDebit: "مدين",
      colCredit: "دائن",
      colBalance: "الرصيد",
      openingBalance: "الرصيد الافتتاحي",
      periodTotal: "مجموع الفترة",
      closingBalance: "الرصيد الختامي",
      from: "من",
      upTo: "حتى",
      allTime: "كل الفترات",
      dr: "مد",
      cr: "دا",
    },
  };
  const t = translations[lang] ?? translations["en"];
  const isRTL = lang === "ar";
  const isSupplier = accountType === "supplier";

  // ── 1. Fetch raw entries ──
  // Wave 18 C: every master is read with the company check (a supplier also
  // when this company posted to it), every list holds this company's vouchers
  // by COALESCE(effective_date, voucher_date) and only the lines the balance
  // engine attributes to the account, so opening + lines foots to the engine.
  let rawEntries: StatementSourceEntry[];
  let accountName: string;

  // A customer, or a ledger account a customer owns, is the customer's ledger
  // statement on the balance engine: the lines the engine attributes to the
  // customer, opened at the engine's period opening.
  let customerOwnerId: number | null = null;
  if (accountType === "customer") {
    customerOwnerId = accountId;
  } else if (accountType === "ledger") {
    const owner = await getCustomerByLedgerId(accountId);
    if (owner && owner.companyId === companyId) customerOwnerId = owner.id;
  }

  if (accountType === "ledger") {
    const [acct] = await db
      .select({ name: ledgerAccounts.name })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.name ?? "Ledger Account";
    rawEntries = customerOwnerId
      ? await customerStatementEntries(companyId, customerOwnerId, startDate, endDate)
      : await storage.getVoucherEntriesByLedger(accountId, startDate, endDate, companyId);
  } else if (accountType === "bank") {
    const [acct] = await db
      .select({ name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, accountId), eq(bankAccounts.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.name ?? "Bank Account";
    rawEntries = await storage.getVoucherEntriesByBankAccount(accountId, startDate, endDate, companyId, {
      ownedOnly: true,
    });
  } else if (accountType === "fixed-asset") {
    const [acct] = await db
      .select({ name: fixedAssets.name })
      .from(fixedAssets)
      .where(and(eq(fixedAssets.id, accountId), eq(fixedAssets.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.name ?? "Fixed Asset";
    rawEntries = await storage.getVoucherEntriesByFixedAsset(accountId, startDate, endDate, companyId, {
      ownedOnly: true,
    });
  } else if (accountType === "supplier") {
    const [acct] = await db
      .select({ legalName: companyScopedSuppliers.legalName, companyId: companyScopedSuppliers.companyId })
      .from(companyScopedSuppliers)
      .where(eq(companyScopedSuppliers.id, accountId));
    // A supplier of another company is shown only when this company posted to it.
    const postedHere =
      acct && acct.companyId && acct.companyId !== companyId
        ? (await getPartyBalance(db, { companyId, kind: "supplier", id: accountId })) !== null
        : true;
    if (!acct || !postedHere) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.legalName ?? "Supplier";
    rawEntries = await storage.getVoucherEntriesBySupplier(accountId, companyId, startDate, endDate, {
      ownedOnly: true,
    });
  } else if (accountType === "employee") {
    const [acct] = await db
      .select({ firstName: employees.firstName, lastName: employees.lastName })
      .from(employees)
      .where(and(eq(employees.id, accountId), eq(employees.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = `${acct.firstName} ${acct.lastName}`;
    rawEntries = await storage.getVoucherEntriesByEmployee(accountId, companyId, startDate, endDate, {
      ownedOnly: true,
    });
  } else if (accountType === "customer") {
    const [acct] = await db
      .select({ legalName: customers.legalName })
      .from(customers)
      .where(and(eq(customers.id, accountId), eq(customers.companyId, companyId)));
    if (!acct) throw new StatementAccountNotFoundError(accountType, accountId);
    accountName = acct.legalName ?? "Customer";
    rawEntries = await customerStatementEntries(companyId, accountId, startDate, endDate);
  } else {
    throw new Error(`Unknown account type: ${accountType}`);
  }

  // ── 2. Opening balance: the balance engine's period opening ──
  // The master's opening with the engine's side rule (a sideless opening takes
  // its account type's usual side: a ledger by its type, an employee or
  // supplier Cr, a bank, fixed asset or customer Dr) plus the lines the engine
  // attributes to the account before startDate — the on-screen statement's
  // pre-period balance. Suppliers run Cr positive, every other family Dr.
  const engineKind = customerOwnerId
    ? "customer"
    : (
        {
          ledger: "ledger",
          bank: "bank",
          "fixed-asset": "fixedAsset",
          supplier: "supplier",
          employee: "employee",
        } as const
      )[accountType as "ledger" | "bank" | "fixed-asset" | "supplier" | "employee"];
  const party = await getPartyBalance(db, {
    companyId,
    kind: engineKind,
    id: customerOwnerId ?? accountId,
    from: startDate ?? null,
  });
  const engineOpening = toMoney(party?.opening);
  const openingBalanceExact: Decimal = isSupplier ? engineOpening.negated() : engineOpening;

  const openingBalance = openingBalanceExact.toNumber();

  // ── 3. Group entries by voucherId ──
  const voucherMap = new Map<
    number,
    {
      voucherId: number;
      voucherNumber: string;
      voucherType: string;
      voucherDate: string;
      description: string;
      narration: string;
      totalDebit: Decimal;
      totalCredit: Decimal;
    }
  >();
  for (const e of rawEntries) {
    const vid = Number(e.voucherId);
    const d = toMoney(e.debitAmount);
    const c = toMoney(e.creditAmount);
    const existing = voucherMap.get(vid);
    if (existing) {
      existing.totalDebit = existing.totalDebit.plus(d);
      existing.totalCredit = existing.totalCredit.plus(c);
      if (!existing.narration && e.narration) existing.narration = e.narration;
    } else {
      voucherMap.set(vid, {
        voucherId: vid,
        voucherNumber: e.voucherNumber ?? "",
        voucherType: e.voucherType ?? "",
        voucherDate: e.voucherDate ?? "",
        description: e.voucherDescription ?? "",
        narration: e.voucherDescription || e.narration || "",
        totalDebit: d,
        totalCredit: c,
      });
    }
  }
  const rows = Array.from(voucherMap.values()).sort((a, b) => {
    const dc = new Date(a.voucherDate).getTime() - new Date(b.voucherDate).getTime();
    return dc !== 0 ? dc : a.voucherNumber.localeCompare(b.voucherNumber);
  });

  // ── 4. Running balance ──
  let running: Decimal = openingBalanceExact;
  const rowsWithBalance = rows.map((r) => {
    running = isSupplier
      ? running.plus(r.totalCredit).minus(r.totalDebit)
      : running.plus(r.totalDebit).minus(r.totalCredit);
    return {
      ...r,
      totalDebit: r.totalDebit.toNumber(),
      totalCredit: r.totalCredit.toNumber(),
      runningBalance: running.toNumber(),
    };
  });

  // ── 5. Company info ──
  const company = await storage.getCompanyById(companyId);
  const settings = await storage.getCompanySettings(companyId);
  const companyName = company?.name ?? "Company";
  const logoUrl: string | null = settings?.logoUrl ?? null;
  const baseCurrency = company?.baseCurrency ?? "USD";
  const currencySymbolMap: Record<string, string> = {
    USD: "$ ",
    GBP: "£",
    EUR: "€",
    CFA: "CFA ",
    XOF: "CFA ",
    XAF: "CFA ",
    CAD: "CA$ ",
    AUD: "A$ ",
    CHF: "CHF ",
    JPY: "¥",
    INR: "₹",
    AED: "AED ",
  };
  const currSym = currencySymbolMap[baseCurrency.toUpperCase()] ?? baseCurrency + " ";
  const fmtAmt = (n: number) => {
    const abs = Math.abs(n);
    const formatted = abs % 1 === 0 ? abs.toLocaleString("en") : abs.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return currSym + formatted;
  };
  const fmtDate = (s: unknown) => {
    if (!s) return "";
    const str = typeof s === "string" ? s : s instanceof Date ? s.toISOString() : String(s);
    const d = new Date(str.split("T")[0] + "T00:00:00");
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  const periodStr =
    startDate && endDate
      ? `${fmtDate(startDate)} — ${fmtDate(endDate)}`
      : startDate
        ? `${t.from} ${fmtDate(startDate)}`
        : endDate
          ? `${t.upTo} ${fmtDate(endDate)}`
          : t.allTime;
  const generatedStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  // ── 6. Build PDF ──
  const PDFDocument = (await import("pdfkit")).default;
  const fs = await import("fs");
  const pathMod = await import("path");

  const fontDir = pathMod.join(process.cwd(), "server", "fonts");
  const arabicFontPath = pathMod.join(fontDir, "Amiri-Regular.ttf");
  const hasArabicFont = fs.existsSync(arabicFontPath);

  const doc = new PDFDocument({ margin: 36, size: "A4" });
  if (hasArabicFont) doc.registerFont("Arabic", arabicFontPath);

  const boldFont = isRTL && hasArabicFont ? "Arabic" : "Helvetica-Bold";
  const normalFont = isRTL && hasArabicFont ? "Arabic" : "Helvetica";

  let convertArabic: ((t: string) => string) | null = null;
  // bidi-js ships no types; the embedding-levels value is opaque and is only
  // ever passed straight back into getReorderedString.
  interface BidiInstance {
    getEmbeddingLevels: (text: string, direction: string) => unknown;
    getReorderedString: (text: string, levels: unknown) => string;
  }
  let bidiInst: BidiInstance | null = null;
  try {
    const reshaperMod = require("arabic-reshaper") as { convertArabic: (t: string) => string };
    convertArabic = reshaperMod.convertArabic;
    const bidiFactory = require("bidi-js") as () => BidiInstance;
    bidiInst = bidiFactory();
  } catch {
    // Failure here is non-fatal and the surrounding flow continues deliberately.
  }

  const containsArabic = (text: string): boolean => /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  const shapeArabic = (text: string): string => {
    if (!text || !convertArabic) return text;
    try {
      const reshaped = convertArabic(text);
      if (bidiInst) {
        const levels = bidiInst.getEmbeddingLevels(reshaped, "rtl");
        return bidiInst.getReorderedString(reshaped, levels);
      }
      return reshaped;
    } catch {
      return text;
    }
  };
  const shapeText = (text: string): string => {
    if (!text) return text;
    if (isRTL) return shapeArabic(text);
    if (containsArabic(text)) return shapeArabic(text);
    return text;
  };

  // ── Column layout (5 cols) ──
  // Left margin=36, right margin=36, page width=595 → usable=523
  // DATE(72) | PARTICULARS(258) | DEBIT(64) | CREDIT(64) | BALANCE(65) = 523
  const LM = 36;
  const RM = 559; // 595 - 36
  const USABLE = RM - LM; // 523
  const colDefs = isRTL
    ? [
        { label: t.colBalance, x: LM, w: 65, align: "right" as const },
        { label: t.colCredit, x: LM + 65, w: 64, align: "right" as const },
        { label: t.colDebit, x: LM + 129, w: 64, align: "right" as const },
        { label: t.colParticulars, x: LM + 193, w: 258, align: "right" as const },
        { label: t.colDate, x: LM + 451, w: 72, align: "right" as const },
      ]
    : [
        { label: t.colDate, x: LM, w: 72, align: "left" as const },
        { label: t.colParticulars, x: LM + 72, w: 258, align: "left" as const },
        { label: t.colDebit, x: LM + 330, w: 64, align: "right" as const },
        { label: t.colCredit, x: LM + 394, w: 64, align: "right" as const },
        { label: t.colBalance, x: LM + 458, w: 65, align: "right" as const },
      ];

  const PAGE_H = 841.89;
  const MARGIN_BOTTOM = 56;
  const FONT_SIZE = 8;
  const HDR_H = 16;
  const MIN_ROW_H = 14;

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  // ── Header block ──
  const headerY = 36;
  let logoWidth = 0;

  // Try company logo
  if (logoUrl && logoUrl.startsWith("/")) {
    const logoPath = `.${logoUrl}`;
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, LM, headerY, { height: 44, fit: [70, 44] });
        logoWidth = 80;
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
    }
  }
  // Fallback: try hmd-logo.png
  if (logoWidth === 0) {
    const fallbackLogo = pathMod.join(process.cwd(), "server", "hmd-logo.png");
    if (fs.existsSync(fallbackLogo)) {
      try {
        doc.image(fallbackLogo, LM, headerY, { height: 44, fit: [70, 44] });
        logoWidth = 80;
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
    }
  }

  const textX = LM + logoWidth;
  const textW = USABLE - logoWidth;

  doc
    .fontSize(16)
    .font(boldFont)
    .fillColor("#1F3864")
    .text(shapeText(companyName), textX, headerY, { width: textW, align: isRTL ? "right" : "left" });

  doc
    .fontSize(10)
    .font(normalFont)
    .fillColor("#333333")
    .text(shapeText(`${t.accountStatement}: ${accountName}`), textX, doc.y + 2, {
      width: textW,
      align: isRTL ? "right" : "left",
    });

  const afterHeader = Math.max(doc.y, headerY + 50);
  doc
    .moveTo(LM, afterHeader + 6)
    .lineTo(RM, afterHeader + 6)
    .lineWidth(0.75)
    .strokeColor("#1F3864")
    .stroke();
  doc.lineWidth(1).strokeColor("#000000");

  const metaY = afterHeader + 12;
  doc.fillColor("#555555").fontSize(8).font(normalFont);
  doc.text(shapeText(`${t.period}: ${periodStr}`), LM, metaY, { width: USABLE, align: isRTL ? "right" : "left" });
  doc.text(shapeText(`${t.generated}: ${generatedStr}`), LM, doc.y + 2, {
    width: USABLE,
    align: isRTL ? "right" : "left",
  });
  doc.moveDown(0.6);

  // ── Table header ──
  const drawTableHeader = (y: number) => {
    doc.rect(LM, y, USABLE, HDR_H).fill("#1F3864");
    doc.fillColor("#ffffff").font(boldFont).fontSize(FONT_SIZE);
    colDefs.forEach((col) => {
      doc.text(shapeText(col.label), col.x + 2, y + 4, { width: col.w - 4, align: col.align });
    });
    doc.fillColor("#000000").font(normalFont).fontSize(FONT_SIZE);
  };

  const tableStartY = doc.y + 4;
  drawTableHeader(tableStartY);
  let y = tableStartY + HDR_H;

  // ── Row helpers ──
  const calcRowH = (vals: string[]): number => {
    doc.font(normalFont).fontSize(FONT_SIZE);
    let maxH = MIN_ROW_H;
    colDefs.forEach((col, i) => {
      const v = vals[i];
      if (!v) return;
      const h = doc.heightOfString(v, { width: col.w - 4 }) + 6;
      if (h > maxH) maxH = h;
    });
    return maxH;
  };

  const drawDataRow = (vals: string[], rowH: number, bg?: string, bold?: boolean) => {
    if (bg) {
      doc.rect(LM, y, USABLE, rowH).fill(bg);
      doc.fillColor("#000000");
    }
    colDefs.forEach((col, i) => {
      const v = vals[i];
      if (v) {
        const cellHasAr = !isRTL && hasArabicFont && containsArabic(v);
        const cellFont = cellHasAr ? "Arabic" : bold ? boldFont : normalFont;
        const cellAlign = cellHasAr ? "right" : col.align;
        doc
          .font(cellFont)
          .fontSize(FONT_SIZE)
          .text(shapeText(v), col.x + 2, y + 3, { width: col.w - 4, align: cellAlign });
      }
    });
  };

  const checkPageBreak = (rowH: number) => {
    if (y + rowH > PAGE_H - MARGIN_BOTTOM) {
      doc.addPage();
      y = 36;
      drawTableHeader(y);
      y += HDR_H;
    }
  };

  // ── Opening balance row ──
  const obSideLabel = openingBalance >= 0 ? (isSupplier ? t.cr : t.dr) : isSupplier ? t.dr : t.cr;
  const obDisplay = `${fmtAmt(openingBalance)} ${obSideLabel}`;
  const obVals = isRTL ? [obDisplay, "-", "-", t.openingBalance, ""] : ["", t.openingBalance, "-", "-", obDisplay];
  const obRowH = calcRowH(obVals);
  checkPageBreak(obRowH);
  drawDataRow(obVals, obRowH, "#EFF3FB", false);
  y += obRowH;

  // ── Transaction rows ──
  rowsWithBalance.forEach((row, idx) => {
    const particulars = row.narration || row.description || row.voucherType || "";
    const debitStr = row.totalDebit > 0 ? fmtAmt(row.totalDebit) : "-";
    const creditStr = row.totalCredit > 0 ? fmtAmt(row.totalCredit) : "-";
    const bal = row.runningBalance;
    const balSide = bal >= 0 ? (isSupplier ? t.cr : t.dr) : isSupplier ? t.dr : t.cr;
    const balStr = `${fmtAmt(bal)} ${balSide}`;
    const txVals = isRTL
      ? [balStr, creditStr, debitStr, particulars, fmtDate(row.voucherDate)]
      : [fmtDate(row.voucherDate), particulars, debitStr, creditStr, balStr];
    const rowH = calcRowH(txVals);
    checkPageBreak(rowH);
    drawDataRow(txVals, rowH, idx % 2 === 1 ? "#F8F8F8" : undefined, false);
    y += rowH;
  });

  // ── Footer summary ──
  y += 4;
  if (y + 36 > PAGE_H - 20) {
    doc.addPage();
    y = 36;
  }

  const totD = sumMoney(rows.map((r) => r.totalDebit)).toNumber();
  const totC = sumMoney(rows.map((r) => r.totalCredit)).toNumber();
  const closingBal =
    rowsWithBalance.length > 0 ? rowsWithBalance[rowsWithBalance.length - 1].runningBalance : openingBalance;
  const closingSide = closingBal >= 0 ? (isSupplier ? t.cr : t.dr) : isSupplier ? t.dr : t.cr;

  const drawSummaryRow = (label: string, debit: string, credit: string, balance: string, navy: boolean) => {
    const bg = navy ? "#1F3864" : "#EFF3FB";
    const fg = navy ? "#ffffff" : "#000000";
    doc.rect(LM, y, USABLE, 17).fill(bg);
    doc
      .fillColor(fg)
      .font(navy ? boldFont : normalFont)
      .fontSize(FONT_SIZE + 0.5);
    // label in PARTICULARS column
    const partCol = colDefs.find(
      (c) => c.label === t.colParticulars || c.label === "PARTICULARS" || c.label === "LIBELLÉ" || c.label === "البيان"
    );
    if (partCol)
      doc.text(shapeText(label), partCol.x + 2, y + 4.5, { width: partCol.w - 4, align: isRTL ? "right" : "left" });
    // debit
    const drCol = colDefs.find(
      (c) => c.label === t.colDebit || c.label === "DEBIT" || c.label === "DÉBIT" || c.label === "مدين"
    );
    if (drCol && debit) doc.text(shapeText(debit), drCol.x + 2, y + 4.5, { width: drCol.w - 4, align: "right" });
    // credit
    const crCol = colDefs.find(
      (c) => c.label === t.colCredit || c.label === "CREDIT" || c.label === "CRÉDIT" || c.label === "دائن"
    );
    if (crCol && credit) doc.text(shapeText(credit), crCol.x + 2, y + 4.5, { width: crCol.w - 4, align: "right" });
    // balance
    const balCol = colDefs.find(
      (c) => c.label === t.colBalance || c.label === "BALANCE" || c.label === "SOLDE" || c.label === "الرصيد"
    );
    if (balCol && balance) doc.text(shapeText(balance), balCol.x + 2, y + 4.5, { width: balCol.w - 4, align: "right" });
    doc.fillColor("#000000");
  };

  drawSummaryRow(t.periodTotal, fmtAmt(totD), fmtAmt(totC), "", false);
  y += 18;
  drawSummaryRow(t.closingBalance, "", "", `${fmtAmt(closingBal)} ${closingSide}`, true);

  return new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
