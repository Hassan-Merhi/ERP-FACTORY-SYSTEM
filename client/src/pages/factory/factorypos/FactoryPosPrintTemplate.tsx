/**
 * Hidden print receipt for the Factory POS page.
 *
 * Split out of FactoryPOS.tsx byte-for-byte in layout: the same inline print
 * styles, the same conditional weight column, the same deduction lines and the
 * same three totals footers (credit balance due, net cash after deductions, or
 * plain total paid).
 */
import { SafeStyle } from "@/components/SafeStyle";
import { ItemsSection, type PrintProps } from "./FactoryPosPrintTemplateParts";

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
        <SafeStyle
          css={`
            @media print {
              body {
                font-family: Arial, Helvetica, sans-serif !important;
              }
              * {
                font-family: Arial, Helvetica, sans-serif !important;
                font-variant-numeric: tabular-nums !important;
              }
            }
          `}
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
