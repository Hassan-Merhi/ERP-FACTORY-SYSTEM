// Extracted from ./POSCustomers.tsx to keep that module under the source-size cap.
import { SafeStyle } from "@/components/SafeStyle";
import { format } from "date-fns";
import { usePOSCustomersState } from "./usePOSCustomersState";

export function POSCustomersSection({
  closingBalance,
  formatAmount,
  formatCashAmount,
  openingBalance,
  printRef,
  selectedCompany,
  sorted,
  statementCustomer,
  totalCr,
  totalDr,
}: Pick<
  ReturnType<typeof usePOSCustomersState>,
  | "closingBalance"
  | "formatAmount"
  | "formatCashAmount"
  | "openingBalance"
  | "printRef"
  | "selectedCompany"
  | "sorted"
  | "statementCustomer"
  | "totalCr"
  | "totalDr"
>) {
  return (
    <div style={{ position: "fixed", top: "-9999px", left: "-9999px", visibility: "hidden", pointerEvents: "none" }}>
      <div
        ref={printRef}
        style={{
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: "10pt",
          padding: "20px",
          backgroundColor: "white",
          color: "black",
        }}
      >
        <SafeStyle
          css={`
            @media print {
              body {
                font-family: Arial, Helvetica, sans-serif !important;
              }
              table {
                width: 100%;
                border-collapse: collapse;
              }
              th,
              td {
                border: 1px solid #ccc;
                padding: 4px 8px;
                font-size: 9pt;
              }
              th {
                background-color: #f0f0f0;
                font-weight: bold;
                text-align: left;
              }
              .text-right {
                text-align: right;
              }
            }
          `}
        />
        <div style={{ textAlign: "center", marginBottom: "12px" }}>
          <div style={{ fontSize: "14pt", fontWeight: "900" }}>Customer Statement</div>
          <div style={{ fontSize: "10pt", color: "#555" }}>{selectedCompany?.name}</div>
          <div style={{ fontSize: "9pt", color: "#777", marginTop: "2px" }}>
            Printed: {new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
          </div>
        </div>
        <div style={{ marginBottom: "10px", padding: "8px", border: "1px solid #ddd", borderRadius: "4px" }}>
          <strong>{statementCustomer?.legalName}</strong>
          {statementCustomer?.phone && (
            <span style={{ marginLeft: "12px", color: "#555" }}>{statementCustomer.phone}</span>
          )}
          <span style={{ float: "right" }}>
            Balance: <strong>{formatCashAmount(statementCustomer?.balance || 0)}</strong>{" "}
            <strong>{statementCustomer?.balanceSide || "Dr"}</strong>
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th className="text-right" style={{ textAlign: "right" }}>
                Debit
              </th>
              <th className="text-right" style={{ textAlign: "right" }}>
                Credit
              </th>
              <th className="text-right" style={{ textAlign: "right" }}>
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {openingBalance !== 0 && (
              <tr style={{ color: "#777" }}>
                <td>—</td>
                <td>
                  <em>Opening Balance</em>
                </td>
                <td></td>
                <td></td>
                <td style={{ textAlign: "right" }}>{formatAmount(Math.abs(openingBalance))}</td>
              </tr>
            )}
            {(() => {
              let r = openingBalance;
              return sorted.map((t, i) => {
                const dr = parseFloat(t.debitAmount || "0");
                const cr = parseFloat(t.creditAmount || "0");
                r = r + dr - cr;
                return (
                  <tr key={i}>
                    <td>{t.voucherDate ? format(new Date(t.voucherDate), "yyyy-MM-dd") : "—"}</td>
                    <td>{t.narration || t.voucherDescription || t.voucherType || "—"}</td>
                    <td style={{ textAlign: "right" }}>{dr > 0 ? formatAmount(dr) : ""}</td>
                    <td style={{ textAlign: "right" }}>{cr > 0 ? formatAmount(cr) : ""}</td>
                    <td style={{ textAlign: "right" }}>
                      {formatAmount(Math.abs(r))} {r >= 0 ? "Dr" : "Cr"}
                    </td>
                  </tr>
                );
              });
            })()}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: "bold", borderTop: "2px solid #333" }}>
              <td colSpan={2}>Total</td>
              <td style={{ textAlign: "right" }}>{formatAmount(totalDr)}</td>
              <td style={{ textAlign: "right" }}>{formatAmount(totalCr)}</td>
              <td style={{ textAlign: "right" }}>
                {formatAmount(Math.abs(closingBalance))} {statementCustomer?.balanceSide || "Dr"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
