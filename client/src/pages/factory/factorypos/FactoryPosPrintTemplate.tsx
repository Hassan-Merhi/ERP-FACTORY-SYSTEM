/**
 * Hidden print receipt for the Factory POS page.
 *
 * Split out of FactoryPOS.tsx byte-for-byte in layout: the same inline print
 * styles, the same conditional weight column, the same deduction lines and the
 * same three totals footers (credit balance due, net cash after deductions, or
 * plain total paid).
 */
import type { RefObject } from "react";
import type { CartRow } from "./types";

const CELL_BORDER = "1px solid #c8c8c8";
const HEAD_BORDER = "1px solid #999";
const HEAD_BG = "#eeeeee";

const headCell = (width?: string, align: "left" | "center" = "center") => ({
  textAlign: align,
  padding: "2px 5px",
  fontWeight: "900",
  fontSize: "7pt",
  border: HEAD_BORDER,
  backgroundColor: HEAD_BG,
  ...(width ? { width } : {}),
});

const bodyCell = (align: "left" | "center" = "center") => ({
  textAlign: align,
  padding: "2px 5px",
  verticalAlign: "top",
  fontWeight: "600",
  fontSize: "7pt",
  border: CELL_BORDER,
});

const footCell = (align: "left" | "center" = "center") => ({
  textAlign: align,
  padding: "2px 5px",
  fontWeight: "900",
  fontSize: "7pt",
  border: HEAD_BORDER,
  backgroundColor: HEAD_BG,
});

interface PrintExpense {
  description?: string | null;
  accountName?: string | null;
  amount?: string | number | null;
}

interface SavedSale {
  cartRows?: CartRow[];
  expenses?: PrintExpense[];
  netTotal?: number;
  total?: number;
  paymentType?: string;
  saleNumber?: string | number;
  txDate?: string;
  customerName?: string | null;
  notes?: string | null;
}

interface PrintProps {
  printRef: RefObject<HTMLDivElement | null>;
  savedSale: SavedSale | null | undefined;
  printUserName: string;
  fmtPrint: (n: number, prefix?: string) => string;
  fmtPrintAmt: (n: number) => string;
}

function ItemsSection({ savedSale, fmtPrint, fmtPrintAmt }: Omit<PrintProps, "printRef" | "printUserName">) {
  const printRows: CartRow[] = savedSale?.cartRows ?? [];
  const hasPrintWeight = printRows.some((r: CartRow) => r.weightPerBale > 0);
  const printTotalQty = printRows.reduce((s: number, r: CartRow) => s + r.quantity, 0);
  const printTotalWeight = printRows.reduce((s: number, r: CartRow) => s + r.quantity * r.weightPerBale, 0);
  const printExpenses = savedSale?.expenses ?? [];
  const printNetTotal: number = savedSale?.netTotal ?? savedSale?.total ?? 0;

  return (
    <>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "7.5pt",
          marginBottom: "0",
          fontVariantNumeric: "tabular-nums",
          border: HEAD_BORDER,
        }}
      >
        <thead>
          <tr>
            <th style={headCell(undefined, "left")}>Description</th>
            <th style={headCell("8%")}>Qty</th>
            {hasPrintWeight && <th style={headCell("12%")}>Wt (kg)</th>}
            <th style={headCell("14%")}>Rate</th>
            <th style={headCell("16%")}>Amt</th>
          </tr>
        </thead>
        <tbody>
          {printRows.map((row: CartRow, idx: number) => {
            const rowBg = idx % 2 === 0 ? "#ffffff" : "#f5f5f5";
            const rowWeight = row.quantity * row.weightPerBale;
            return (
              <tr key={idx} style={{ backgroundColor: rowBg }}>
                <td style={{ ...bodyCell("left"), lineHeight: "1.2" }}>
                  {row.productName}
                  {row.articleCode ? (
                    <span style={{ color: "#666", fontSize: "6.5pt" }}> ({row.articleCode})</span>
                  ) : null}
                </td>
                <td style={bodyCell()}>{fmtPrint(row.quantity)}</td>
                {hasPrintWeight && <td style={bodyCell()}>{rowWeight > 0 ? fmtPrint(rowWeight) : "—"}</td>}
                <td style={bodyCell()}>{fmtPrintAmt(row.unitPrice)}</td>
                <td style={bodyCell()}>{fmtPrintAmt(row.quantity * row.unitPrice)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td style={footCell("left")}>TOTAL</td>
            <td style={footCell()}>{fmtPrint(printTotalQty)}</td>
            {hasPrintWeight && <td style={footCell()}>{fmtPrint(printTotalWeight)}</td>}
            <td style={{ padding: "2px 5px", border: HEAD_BORDER, backgroundColor: HEAD_BG }}></td>
            <td style={footCell()}>{fmtPrintAmt(savedSale?.total ?? 0)}</td>
          </tr>
        </tfoot>
      </table>

      {/* Expense deductions on receipt */}
      {printExpenses.length > 0 && (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "7.5pt",
            marginTop: "3px",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <tbody>
            {printExpenses.map((exp, idx: number) => (
              <tr key={idx}>
                <td style={{ padding: "2px 5px", fontSize: "7pt", fontWeight: "600", color: "#333" }}>
                  {exp.description || exp.accountName || "Deduction"}
                </td>
                <td
                  style={{ textAlign: "right", padding: "2px 5px", fontSize: "7pt", fontWeight: "700", color: "#c00" }}
                >
                  -{fmtPrintAmt(parseFloat(String(exp.amount ?? "0")))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Total Paid / Net Cash */}
      {savedSale?.paymentType === "CREDIT" ? (
        <>
          <div
            style={{
              fontSize: "11pt",
              fontWeight: "900",
              marginTop: "4px",
              paddingTop: "4px",
              borderTop: "1.5px solid #333",
              display: "flex",
              justifyContent: "space-between",
              color: "#a00",
            }}
          >
            <span>BALANCE DUE:</span>
            <span>{fmtPrintAmt(savedSale?.total ?? 0)}</span>
          </div>
          <div style={{ textAlign: "center", fontSize: "7.5pt", fontWeight: "700", marginTop: "3px", color: "#a00" }}>
            *** CREDIT SALE ***
          </div>
        </>
      ) : printExpenses.length > 0 ? (
        <>
          <div
            style={{
              fontSize: "9pt",
              fontWeight: "700",
              marginTop: "4px",
              paddingTop: "4px",
              borderTop: "1px solid #ccc",
              display: "flex",
              justifyContent: "space-between",
              color: "#555",
            }}
          >
            <span>SALES TOTAL:</span>
            <span>{fmtPrintAmt(savedSale?.total ?? 0)}</span>
          </div>
          <div
            style={{
              fontSize: "11pt",
              fontWeight: "900",
              marginTop: "3px",
              paddingTop: "3px",
              borderTop: "1.5px solid #333",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>NET CASH RECEIVED:</span>
            <span>{fmtPrintAmt(printNetTotal)}</span>
          </div>
        </>
      ) : (
        <div
          style={{
            fontSize: "11pt",
            fontWeight: "900",
            marginTop: "5px",
            paddingTop: "5px",
            borderTop: "1.5px solid #333",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>TOTAL PAID:</span>
          <span>{fmtPrintAmt(savedSale?.total ?? 0)}</span>
        </div>
      )}
    </>
  );
}

export function FactoryPosPrintTemplate({ printRef, savedSale, printUserName, fmtPrint, fmtPrintAmt }: PrintProps) {
  return (
    <div className="hidden">
      <div
        ref={printRef as React.RefObject<HTMLDivElement>}
        style={{
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: "8pt",
          padding: "8px",
          backgroundColor: "white",
          color: "black",
          width: "100%",
          fontWeight: "normal",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <style
          dangerouslySetInnerHTML={{
            __html: `
                @media print {
                  body { font-family: Arial, Helvetica, sans-serif !important; }
                  * { font-family: Arial, Helvetica, sans-serif !important; font-variant-numeric: tabular-nums !important; }
                }
              `,
          }}
        />

        {/* Title */}
        <div
          style={{
            textAlign: "center",
            fontWeight: "900",
            fontSize: "13pt",
            letterSpacing: "1px",
            marginBottom: "4px",
          }}
        >
          FACTORY POS INVOICE
        </div>

        {/* Sale # centered */}
        {savedSale?.saleNumber && (
          <div style={{ textAlign: "center", fontSize: "8pt", fontWeight: "700", marginBottom: "3px" }}>
            #{savedSale.saleNumber}
          </div>
        )}

        {/* Date / User row */}
        <div
          style={{
            fontSize: "8pt",
            fontWeight: "700",
            display: "flex",
            justifyContent: "space-between",
            borderTop: "1.5px solid black",
            borderBottom: "1.5px solid black",
            padding: "3px 0",
            marginBottom: "4px",
          }}
        >
          <span>Date: {savedSale?.txDate}</span>
          <span>User: {printUserName}</span>
        </div>

        {/* Customer info */}
        {savedSale?.customerName && (
          <div
            style={{
              fontSize: "8pt",
              fontWeight: "700",
              marginBottom: "4px",
              padding: "3px",
              border: "1.5px solid black",
            }}
          >
            <div style={{ fontWeight: "900" }}>Customer</div>
            <div>{savedSale.customerName}</div>
          </div>
        )}

        {/* Items table */}
        <ItemsSection savedSale={savedSale} fmtPrint={fmtPrint} fmtPrintAmt={fmtPrintAmt} />

        {/* Notes */}
        {savedSale?.notes && (
          <div
            dir="auto"
            style={{
              fontSize: "8pt",
              fontWeight: "600",
              marginTop: "5px",
              padding: "3px",
              border: "1.5px solid black",
            }}
          >
            <span style={{ fontWeight: "900" }}>Note:</span> {savedSale.notes}
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            textAlign: "center",
            fontSize: "7.5pt",
            fontWeight: "700",
            marginTop: "6px",
            paddingTop: "4px",
            borderTop: "1.5px solid black",
          }}
        >
          <div>Thank you for your business!</div>
        </div>
      </div>
    </div>
  );
}
