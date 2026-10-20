/** Native EUR statements for Factory FX agents. Historical USD GL is not re-denominated. */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { toMoney } from "../../lib/money";
import { getErrorMessage } from "../../lib/httpHandlers";
import { writeWorkbook } from "../../excelHelper";
import { fxAgentTablesExist } from "../../services/factory/fxAgentWalletDb";

type EurRow = {
  id: number; date: string; kind: string; description: string; detail: string;
  eurIn: string; eurOut: string; balance: string; rateUsdPerEur: string; voucherId: number | null;
};
type EurStatement = {
  accountName: string; activatedOn: string; fromDate: string | null; toDate: string;
  openingEur: string; totalEurIn: string; totalEurOut: string; closingEur: string;
  rows: EurRow[];
};
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const money = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

function dates(req: Request) {
  const rawFrom = req.query.startDate, rawTo = req.query.endDate;
  if ((rawFrom !== undefined && (typeof rawFrom !== "string" || !isoDate.test(rawFrom))) ||
      (rawTo !== undefined && (typeof rawTo !== "string" || !isoDate.test(rawTo)))) {
    throw new Error("Statement dates must be YYYY-MM-DD");
  }
  const fromDate = (rawFrom as string | undefined) || null;
  const toDate = (rawTo as string | undefined) || getClientDate(req);
  if (toDate > getClientDate(req) || (fromDate && fromDate > toDate) ||
      [fromDate, toDate].some(v => v && (!Number.isFinite(Date.parse(v + "T00:00:00Z")) ||
        new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v))) {
    throw new Error("Invalid FX statement date range");
  }
  return { fromDate, toDate };
}

async function build(req: Request): Promise<EurStatement> {
  const companyId = Number(req.session.factoryCompanyId || req.session.currentCompanyId || 0);
  const walletId = Number(req.params.id);
  if (!companyId || !Number.isSafeInteger(walletId) || walletId <= 0) throw new Error("Select a valid FX wallet");
  if (!(await fxAgentTablesExist())) throw new Error("FX wallet migration required");
  const { fromDate, toDate } = dates(req);
  const found = await db.execute(sql`
    SELECT a.name AS "accountName", w.activated_on::text AS "activatedOn"
    FROM factory_fx_agent_wallets w JOIN ledger_accounts a ON a.id = w.ledger_account_id
    WHERE w.company_id = ${companyId} AND w.id = ${walletId}
      AND a.company_id = ${companyId} AND a.deleted_at IS NULL LIMIT 1
  `);
  const wallet = found.rows[0];
  if (!wallet) throw new Error("FX wallet not found in this company");
  // Include pre-period events to calculate the opening EUR balance correctly.
  const ops = await db.execute(sql`
    SELECT op.id, op.effective_date::text AS date, op.kind,
      op.source_amount::text AS "sourceAmount", op.target_amount::text AS "targetAmount",
      op.rate_usd_per_eur::text AS rate, op.narration, op.voucher_id AS "voucherId",
      CASE WHEN op.target_kind = 'ledger' THEN la.name
           WHEN op.target_kind = 'factorySupplier' THEN fs.name ELSE NULL END AS beneficiary
    FROM factory_fx_agent_wallet_operations op
    LEFT JOIN ledger_accounts la ON op.target_kind = 'ledger' AND op.target_id = la.id
      AND la.company_id = ${companyId}
    LEFT JOIN factory_suppliers fs ON op.target_kind = 'factorySupplier' AND op.target_id = fs.id
      AND fs.company_id = ${companyId}
    WHERE op.company_id = ${companyId} AND op.wallet_id = ${walletId}
      AND op.effective_date <= ${toDate}::date
    ORDER BY op.effective_date, op.id
  `);
  let balance = toMoney(0), opening = toMoney(0), totalIn = toMoney(0), totalOut = toMoney(0);
  const rows: EurRow[] = [];
  for (const op of ops.rows) {
    const kind = String(op.kind), date = String(op.date).slice(0, 10);
    const eurIn = kind === "USD_TO_EUR" ? toMoney(String(op.targetAmount)) : toMoney(0);
    const eurOut = kind === "EUR_SETTLEMENT" || kind === "EUR_TO_USD_REVERSAL"
      ? toMoney(String(op.sourceAmount)) : toMoney(0);
    if (eurIn.isZero() && eurOut.isZero()) throw new Error("Unsupported EUR wallet operation");
    balance = balance.plus(eurIn).minus(eurOut);
    if (balance.lt(0)) throw new Error("Invalid negative EUR wallet balance");
    if (fromDate && date < fromDate) { opening = balance; continue; }
    totalIn = totalIn.plus(eurIn); totalOut = totalOut.plus(eurOut);
    const beneficiary = op.beneficiary ? String(op.beneficiary) : null;
    const description = kind === "USD_TO_EUR" ? "USD converted to EUR" :
      kind === "EUR_TO_USD_REVERSAL" ? "EUR conversion reversed" :
      "EUR payment" + (beneficiary ? " to " + beneficiary : "");
    rows.push({
      id: Number(op.id), date, kind, description, detail: String(op.narration || ""),
      eurIn: eurIn.toFixed(6), eurOut: eurOut.toFixed(6),
      balance: balance.toFixed(6), rateUsdPerEur: String(op.rate),
      voucherId: op.voucherId == null ? null : Number(op.voucherId),
    });
  }
  return {
    accountName: String(wallet.accountName), activatedOn: String(wallet.activatedOn).slice(0, 10),
    fromDate, toDate, openingEur: opening.toFixed(6), totalEurIn: totalIn.toFixed(6),
    totalEurOut: totalOut.toFixed(6), closingEur: balance.toFixed(6), rows,
  };
}

const filename = (s: EurStatement, ext: string) =>
  (s.accountName.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 70) || "FX_Agent") + "_EUR_Statement." + ext;

async function pdf(s: EurStatement): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#1e293b").text("EUR Statement");
    doc.moveDown(0.3).font("Helvetica").fontSize(11).text(s.accountName);
    doc.fontSize(9).fillColor("#64748b")
      .text("Period: " + (s.fromDate || s.activatedOn) + " to " + s.toDate);
    doc.moveDown().font("Helvetica-Bold").fontSize(11).fillColor("#0f172a")
      .text("Opening EUR " + money(s.openingEur) + "            Closing EUR " + money(s.closingEur));
    doc.moveDown();
    let y = doc.y + 10;
    const heads = [36, 110, 333, 406, 476];
    const header = () => {
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#334155");
      ["DATE", "TRANSACTION", "EUR IN", "EUR OUT", "EUR BALANCE"].forEach((t, i) =>
        doc.text(t, heads[i], y, { width: [68, 215, 69, 67, 83][i], align: i > 1 ? "right" : "left" }));
      y += 20;
      doc.moveTo(36, y - 5).lineTo(559, y - 5).strokeColor("#cbd5e1").stroke();
    };
    header();
    const line = (date: string, name: string, incoming: string, outgoing: string, balance: string) => {
      if (y > 740) { doc.addPage(); y = 42; header(); }
      doc.font("Helvetica").fontSize(8).fillColor("#1e293b");
      [date, name.slice(0, 90), incoming, outgoing, balance].forEach((v, i) =>
        doc.text(v, heads[i], y, { width: [68, 215, 69, 67, 83][i],
          height: 30, ellipsis: true, align: i > 1 ? "right" : "left" }));
      y += 35;
      doc.moveTo(36, y - 4).lineTo(559, y - 4).strokeColor("#e2e8f0").stroke();
    };
    line(s.fromDate || s.activatedOn, "Opening EUR balance", "", "", money(s.openingEur));
    for (const row of s.rows) line(row.date, row.description,
      row.eurIn === "0.000000" ? "" : money(row.eurIn),
      row.eurOut === "0.000000" ? "" : money(row.eurOut), money(row.balance));
    if (y > 727) { doc.addPage(); y = 42; }
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a")
      .text("TOTAL", 110, y)
      .text(money(s.totalEurIn), 333, y, { width: 69, align: "right" })
      .text(money(s.totalEurOut), 406, y, { width: 67, align: "right" })
      .text(money(s.closingEur), 476, y, { width: 83, align: "right" });
    doc.font("Helvetica").fontSize(8).fillColor("#64748b")
      .text("Native EUR transactions only. Historical USD vouchers are shown separately.", 36, y + 29);
    doc.end();
  });
}

async function xlsx(s: EurStatement): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = "Business OS";
  const sheet = book.addWorksheet("EUR Statement", { views: [{ state: "frozen", ySplit: 6 }] });
  sheet.columns = [{ width: 15 }, { width: 43 }, { width: 37 }, { width: 17 },
    { width: 17 }, { width: 19 }, { width: 19 }];
  sheet.mergeCells("A1:G1");
  sheet.getCell("A1").value = "EUR Account Statement";
  sheet.getCell("A1").font = { bold: true, size: 17, color: { argb: "FF183153" } };
  sheet.mergeCells("A2:G2"); sheet.getCell("A2").value = s.accountName;
  sheet.mergeCells("A3:G3");
  sheet.getCell("A3").value = "Period: " + (s.fromDate || s.activatedOn) + " to " + s.toDate;
  sheet.mergeCells("A4:G4");
  sheet.getCell("A4").value = "Opening EUR: " + money(s.openingEur) + "    Closing EUR: " + money(s.closingEur);
  const head = sheet.addRow(["Date", "Transaction", "Details", "EUR In", "EUR Out", "EUR Balance", "USD/EUR Rate"]);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF183153" } };
  sheet.addRow([s.fromDate || s.activatedOn, "Opening EUR balance", "", null, null, Number(s.openingEur)]);
  for (const row of s.rows) sheet.addRow([row.date, row.description, row.detail,
    row.eurIn === "0.000000" ? null : Number(row.eurIn),
    row.eurOut === "0.000000" ? null : Number(row.eurOut),
    Number(row.balance), Number(row.rateUsdPerEur)]);
  const total = sheet.addRow(["", "TOTAL", "", Number(s.totalEurIn), Number(s.totalEurOut), Number(s.closingEur)]);
  total.font = { bold: true };
  total.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0F7" } };
  for (let n = 6; n <= total.number; n++) {
    for (const col of [4, 5, 6]) sheet.getRow(n).getCell(col).numFmt = "#,##0.00####";
    sheet.getRow(n).getCell(7).numFmt = "0.000000";
  }
  sheet.addRow(["Native EUR wallet transactions; historical USD vouchers are excluded."]);
  return writeWorkbook(book);
}

export function registerFactoryFxAgentStatementRoutes(app: Express) {
  const route = "/api/factory/fx-agent-wallets/:id/statement";
  app.get(route, requireAuth, async (req: Request, res: Response) => {
    try { res.setHeader("Cache-Control", "no-store"); res.json(await build(req)); }
    catch (error) { res.status(400).json({ message: getErrorMessage(error) }); }
  });
  app.get(route + ".pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const statement = await build(req); const buffer = await pdf(statement);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="' + filename(statement, "pdf") + '"');
      res.setHeader("Cache-Control", "no-store"); res.end(buffer);
    } catch (error) { if (!res.headersSent) res.status(400).json({ message: getErrorMessage(error) }); }
  });
  app.get(route + ".xlsx", requireAuth, async (req: Request, res: Response) => {
    try {
      const statement = await build(req); const buffer = await xlsx(statement);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="' + filename(statement, "xlsx") + '"');
      res.setHeader("Cache-Control", "no-store"); res.end(buffer);
    } catch (error) { if (!res.headersSent) res.status(400).json({ message: getErrorMessage(error) }); }
  });
}
