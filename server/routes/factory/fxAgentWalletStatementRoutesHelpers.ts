// Extracted from ./fxAgentWalletStatementRoutes.ts
import PDFDocument from "pdfkit";

export type EurRow = {
  id: number;
  date: string;
  kind: string;
  description: string;
  detail: string;
  eurIn: string;
  eurOut: string;
  balance: string;
  rateUsdPerEur: string;
  voucherId: number | null;
  deleted?: boolean;
};

export type EurStatement = {
  accountName: string;
  activatedOn: string;
  fromDate: string | null;
  toDate: string;
  openingEur: string;
  totalEurIn: string;
  totalEurOut: string;
  closingEur: string;
  rows: EurRow[];
};

export const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const money = (v: string) =>
  Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export async function pdf(s: EurStatement): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#1e293b").text("EUR Account Ledger");
    doc.moveDown(0.3).font("Helvetica").fontSize(11).text(s.accountName);
    doc
      .fontSize(9)
      .fillColor("#64748b")
      .text("Period: " + (s.fromDate || s.activatedOn) + " to " + s.toDate);
    doc
      .moveDown(0.6)
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#0f172a")
      .text("Opening: EUR " + money(s.openingEur) + "    Closing: EUR " + money(s.closingEur));
    doc.moveDown();
    let y = doc.y + 9;
    const x = [36, 93, 265, 385, 443, 501];
    const widths = [54, 167, 116, 54, 54, 58];
    const heading = () => {
      doc.rect(36, y - 4, 523, 20).fill("#e9eef5");
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#334155");
      ["DATE", "PARTICULARS", "NOTES", "DEBIT", "CREDIT", "BALANCE"].forEach((t, i) =>
        doc.text(t, x[i], y + 2, { width: widths[i], align: i >= 3 ? "right" : "left" })
      );
      y += 24;
    };
    const line = (
      date: string,
      particulars: string,
      notes: string,
      debit: string,
      credit: string,
      balance: string,
      deleted = false
    ) => {
      if (y > 733) {
        doc.addPage();
        y = 42;
        heading();
      }
      doc
        .font("Helvetica")
        .fontSize(7.8)
        .fillColor(deleted ? "#94a3b8" : "#1e293b");
      [date, particulars, notes, debit, credit, balance].forEach((v, i) =>
        doc.text(v, x[i], y, { width: widths[i], height: 30, ellipsis: true, align: i >= 3 ? "right" : "left" })
      );
      y += 36;
      doc
        .moveTo(36, y - 5)
        .lineTo(559, y - 5)
        .strokeColor("#e2e8f0")
        .stroke();
    };
    heading();
    line(s.fromDate || s.activatedOn, "Opening Balance", "", "", "", money(s.openingEur));
    for (const row of s.rows) {
      const notes = [
        row.detail,
        row.rateUsdPerEur ? "USD/EUR " + row.rateUsdPerEur : "",
        row.voucherId ? "Voucher #" + row.voucherId : "",
        row.deleted ? "DELETED — excluded from balance" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      line(
        row.date,
        row.description,
        notes,
        row.eurIn === "0.000000" ? "" : money(row.eurIn),
        row.eurOut === "0.000000" ? "" : money(row.eurOut),
        row.deleted ? "—" : money(row.balance),
        row.deleted
      );
    }
    if (y > 732) {
      doc.addPage();
      y = 42;
      heading();
    }
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#0f172a");
    doc
      .text("CLOSING TOTAL", 93, y)
      .text(money(s.totalEurIn), 385, y, { width: 54, align: "right" })
      .text(money(s.totalEurOut), 443, y, { width: 54, align: "right" })
      .text(money(s.closingEur), 501, y, { width: 58, align: "right" });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#64748b")
      .text(
        "All amounts in EUR. Deleted payments (if shown) are excluded from balances. Historical USD vouchers are separate.",
        36,
        y + 27,
        { width: 523 }
      );
    doc.end();
  });
}
