import { format } from "date-fns";

// Local shape matching how this component actually uses entries (accountId is
// only used by callers for filtering before passing entries in, not read here).
// Callers pass richer rows; structural typing accepts those without this needing
// an index signature that would hide a misspelled field.
interface VoucherEntry {
  accountId?: number;
  accountName: string;
  amount: string;
}

export const PrintTemplate = ({
  voucherType,
  paymentAccountName,
  date,
  entries,
  notes,
  total,
  formatAmount,
  companyName,
}: {
  voucherType: "Payment" | "Receipt";
  paymentAccountName: string;
  date: Date;
  entries: VoucherEntry[];
  notes: string;
  total: number;
  formatAmount: (amount: number | string) => string;
  companyName?: string;
}) => {
  const voucherRef = `${voucherType === "Payment" ? "PV" : "RV"}-${format(date, "yyyyMMdd")}-${Date.now().toString().slice(-4)}`;
  return (
    <div
      style={{
        fontFamily: "Arial, sans-serif",
        padding: "32px",
        maxWidth: "720px",
        margin: "0 auto",
        background: "#fff",
        color: "#000",
      }}
    >
      <div style={{ border: "1px solid #000" }}>
        {/* Header */}
        <div style={{ background: "#1a1a2e", color: "#fff", padding: "20px 28px", textAlign: "center" }}>
          {companyName && (
            <div style={{ fontSize: "22px", fontWeight: "700", letterSpacing: "0.5px", marginBottom: "4px" }}>
              {companyName}
            </div>
          )}
          <div style={{ fontSize: "13px", letterSpacing: "3px", textTransform: "uppercase", opacity: 0.8 }}>
            {voucherType} Voucher
          </div>
        </div>

        {/* Meta row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "14px 28px",
            borderBottom: "1px solid #ddd",
            background: "#f9f9f9",
            fontSize: "13px",
          }}
        >
          <div>
            <span style={{ color: "#555" }}>{voucherType === "Payment" ? "Paid From:" : "Received In:"}</span>
            <span style={{ fontWeight: "600", marginLeft: "8px" }}>{paymentAccountName || "—"}</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div>
              <span style={{ color: "#555" }}>Date:</span> <strong>{format(date, "dd MMM yyyy")}</strong>
            </div>
            <div style={{ fontSize: "11px", color: "#777", marginTop: "2px" }}>Ref: {voucherRef}</div>
          </div>
        </div>

        {/* Entries table */}
        <div style={{ padding: "20px 28px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead className="sticky top-0 z-30 bg-muted/50">
              <tr style={{ background: "#f0f0f0" }}>
                <th style={{ border: "1px solid #ccc", padding: "8px 10px", textAlign: "left", width: "40px" }}>#</th>
                <th style={{ border: "1px solid #ccc", padding: "8px 10px", textAlign: "left" }}>
                  Account / Description
                </th>
                <th style={{ border: "1px solid #ccc", padding: "8px 10px", textAlign: "right", width: "130px" }}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={index} style={{ background: index % 2 === 1 ? "#fafafa" : "#fff" }}>
                  <td style={{ border: "1px solid #ccc", padding: "8px 10px" }}>{index + 1}</td>
                  <td style={{ border: "1px solid #ccc", padding: "8px 10px" }}>{entry.accountName}</td>
                  <td
                    style={{
                      border: "1px solid #ccc",
                      padding: "8px 10px",
                      textAlign: "right",
                      fontFamily: "monospace",
                    }}
                  >
                    {formatAmount(entry.amount || "0")}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#1a1a2e", color: "#fff", fontWeight: "700" }}>
                <td
                  colSpan={2}
                  style={{ border: "1px solid #000", padding: "9px 10px", textAlign: "right", letterSpacing: "0.5px" }}
                >
                  TOTAL
                </td>
                <td
                  style={{
                    border: "1px solid #000",
                    padding: "9px 10px",
                    textAlign: "right",
                    fontFamily: "monospace",
                    fontSize: "14px",
                  }}
                >
                  {formatAmount(total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Notes */}
        {notes && (
          <div style={{ padding: "0 28px 20px", fontSize: "12px" }}>
            <div style={{ background: "#f9f9f9", border: "1px solid #ddd", borderRadius: "4px", padding: "10px 14px" }}>
              <strong>Notes:</strong>
              <span style={{ marginLeft: "8px", whiteSpace: "pre-wrap" }}>{notes}</span>
            </div>
          </div>
        )}

        {/* Signature section */}
        <div
          style={{
            borderTop: "1px solid #ddd",
            padding: "24px 28px 28px",
            display: "flex",
            justifyContent: "space-between",
            gap: "16px",
          }}
        >
          {[
            { label: "Prepared By", sub: "Name & Signature" },
            { label: "Received By", sub: "Name & Signature" },
            { label: "Authorized By", sub: "Name & Signature" },
          ].map(({ label, sub }) => (
            <div key={label} style={{ flex: 1, textAlign: "center" }}>
              <div style={{ height: "56px", borderBottom: "1px solid #000", marginBottom: "6px" }} />
              <div style={{ fontSize: "12px", fontWeight: "600" }}>{label}</div>
              <div style={{ fontSize: "10px", color: "#777", marginTop: "2px" }}>{sub}</div>
              <div style={{ fontSize: "10px", color: "#777", marginTop: "6px" }}>Date: _______________</div>
            </div>
          ))}
        </div>

        {/* Footer strip */}
        <div
          style={{
            background: "#1a1a2e",
            color: "#aaa",
            fontSize: "10px",
            textAlign: "center",
            padding: "6px",
            letterSpacing: "0.5px",
          }}
        >
          {companyName ? `${companyName} — ` : ""}
          {voucherType} Voucher · {format(date, "dd MMM yyyy")} · {voucherRef}
        </div>
      </div>
    </div>
  );
};

interface _VouchersProps {
  posUser?: unknown;
}

export function parseDateLocal(dateStr: string): Date {
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  }
  return new Date(dateStr);
}
