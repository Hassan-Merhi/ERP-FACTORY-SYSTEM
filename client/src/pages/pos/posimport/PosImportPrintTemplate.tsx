/**
 * Hidden print receipt for the POS Import page.
 *
 * Split out of POSImport.tsx unchanged: the same inline print styles, the
 * Mali-only daily exchange rate banner, the credit-sale customer block and a
 * totals footer that always prints USD amounts.
 */
import type { RefObject } from "react";
import { formatNumber } from "@/lib/formatNumber";
import { SafeStyle } from "@/components/SafeStyle";

const CENTER_CELL = { textAlign: "center" as const, padding: "4px 3px", verticalAlign: "top", fontWeight: "600" };

interface PrintSaleItem {
  name?: string;
  stockItemName?: string;
  itemCode?: string;
  quantity?: number | string;
  rate?: number | string;
}

interface PrintSale {
  items?: PrintSaleItem[];
  saleDate?: string;
  isCreditSale?: boolean;
  customer?: { name?: string } | null;
  voucher?: { exchangeRate?: string; description?: string } | null;
}

interface PrintProps {
  printRef: RefObject<HTMLDivElement | null>;
  importedSale: PrintSale | null | undefined;
  printUserName: string;
  printCurrPrefix: string;
  selectedCompany: { name?: string } | null | undefined;
  exchangeRate: number | null | undefined;
  fmtPrint: (n: number, prefix?: string) => string;
}

function ItemsTable({
  importedSale,
  printCurrPrefix,
  fmtPrint,
}: Pick<PrintProps, "importedSale" | "printCurrPrefix" | "fmtPrint">) {
  const items = importedSale?.items ?? [];
  const totalQty = items.reduce((sum: number, item: PrintSaleItem) => sum + Number(item.quantity ?? 0), 0);
  const totalAmount = items.reduce(
    (sum: number, item: PrintSaleItem) => sum + Number(item.quantity ?? 0) * Number(item.rate ?? 0),
    0
  );
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "11pt",
        marginBottom: "0",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <thead className="sticky top-0 z-30 bg-muted/50">
        <tr style={{ borderBottom: "2px solid black" }}>
          <th
            style={{
              textAlign: "left",
              padding: "4px 3px",
              width: "48%",
              fontWeight: "900",
              borderRight: "2px solid black",
            }}
          >
            Description
          </th>
          <th style={{ textAlign: "center", padding: "4px 3px", width: "12%", fontWeight: "900" }}>Qty</th>
          <th style={{ textAlign: "center", padding: "4px 3px", width: "20%", fontWeight: "900" }}>Rate</th>
          <th style={{ textAlign: "center", padding: "4px 3px", width: "20%", fontWeight: "900" }}>Amt</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item: PrintSaleItem, idx: number) => {
          const rate = Number(item.rate ?? 0);
          const qty = Number(item.quantity ?? 0);
          return (
            <tr
              key={idx}
              style={{
                borderBottom: "1px solid #b0b8c1",
                backgroundColor: idx % 2 === 0 ? "white" : "#f2f5f8",
              }}
            >
              <td
                style={{
                  padding: "4px 3px",
                  verticalAlign: "top",
                  wordBreak: "break-word",
                  fontWeight: "600",
                  lineHeight: "1.3",
                  borderRight: "2px solid black",
                }}
              >
                {item.stockItemName || item.itemCode}
              </td>
              <td style={CENTER_CELL}>{fmtPrint(qty)}</td>
              <td style={CENTER_CELL}>{fmtPrint(rate, printCurrPrefix)}</td>
              <td style={CENTER_CELL}>{fmtPrint(qty * rate, printCurrPrefix)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr style={{ borderTop: "2px solid black", fontWeight: "900" }}>
          <td style={{ padding: "5px 3px", fontWeight: "900", borderRight: "2px solid black" }}>TOTAL</td>
          <td style={{ textAlign: "center", padding: "5px 3px" }}>{fmtPrint(totalQty)}</td>
          <td style={{ padding: "5px 3px" }}></td>
          <td style={{ textAlign: "center", padding: "5px 3px", fontWeight: "900" }}>
            {fmtPrint(totalAmount, printCurrPrefix)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

export function PosImportPrintTemplate({
  printRef,
  importedSale,
  printUserName,
  printCurrPrefix,
  selectedCompany,
  exchangeRate,
  fmtPrint,
}: PrintProps) {
  const items = importedSale?.items ?? [];
  const totalPaid = items.reduce(
    (sum: number, item: PrintSaleItem) => sum + Number(item.quantity ?? 0) * Number(item.rate ?? 0),
    0
  );
  const showDailyRate =
    selectedCompany?.name?.toLowerCase().includes("mali") && (importedSale?.voucher?.exchangeRate || exchangeRate);

  return (
    <div className="hidden">
      <div
        ref={printRef as React.RefObject<HTMLDivElement>}
        style={{
          fontFamily: "Arial, Helvetica, sans-serif",
          fontSize: "11pt",
          padding: "12px",
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
            fontSize: "18pt",
            letterSpacing: "2px",
            marginBottom: "6px",
          }}
        >
          POS INVOICE
        </div>

        {/* Invoice Info */}
        <div
          style={{
            fontSize: "11pt",
            fontWeight: "700",
            display: "flex",
            justifyContent: "space-between",
            borderTop: "2px solid black",
            borderBottom: "2px solid black",
            padding: "5px 0",
            marginBottom: "6px",
          }}
        >
          <span>Date: {importedSale?.saleDate}</span>
          <span>User: {printUserName}</span>
        </div>

        {/* Daily Exchange Rate - Only for Mali company */}
        {showDailyRate && (
          <div
            style={{
              fontSize: "11pt",
              fontWeight: "700",
              marginBottom: "6px",
              padding: "4px",
              border: "2px solid black",
              textAlign: "center",
            }}
          >
            <span style={{ fontWeight: "900" }}>Daily Rate:</span> $1 ={" "}
            {formatNumber(Number(importedSale?.voucher?.exchangeRate ?? 0) || exchangeRate || 0)} CFA
          </div>
        )}

        {/* Credit Sale Customer Info */}
        {importedSale?.isCreditSale && importedSale?.customer && (
          <div
            style={{
              fontSize: "10pt",
              fontWeight: "700",
              marginBottom: "6px",
              padding: "4px",
              border: "2px solid black",
            }}
          >
            <div style={{ fontWeight: "900" }}>CREDIT SALE</div>
            <div>Customer: {importedSale.customer.name}</div>
          </div>
        )}

        {/* Items Table */}
        <ItemsTable importedSale={importedSale} printCurrPrefix={printCurrPrefix} fmtPrint={fmtPrint} />

        {/* Total Paid */}
        <div
          style={{
            fontSize: "14pt",
            fontWeight: "900",
            marginTop: "8px",
            paddingTop: "8px",
            borderTop: "2px solid black",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>TOTAL PAID:</span>
          <span>{fmtPrint(totalPaid, printCurrPrefix)}</span>
        </div>

        {/* Notes */}
        {importedSale?.voucher?.description && (
          <div
            style={{ fontSize: "9pt", fontWeight: "600", marginTop: "8px", padding: "4px", border: "2px solid black" }}
          >
            <span style={{ fontWeight: "900" }}>Note:</span> {importedSale.voucher.description}
          </div>
        )}

        {/* Footer */}
        <div
          style={{
            textAlign: "center",
            fontSize: "9pt",
            fontWeight: "700",
            marginTop: "10px",
            paddingTop: "5px",
            borderTop: "2px solid black",
          }}
        >
          <div>Thank you for your business!</div>
        </div>
      </div>
    </div>
  );
}
