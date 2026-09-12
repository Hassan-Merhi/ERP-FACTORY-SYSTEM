import { formatNumber } from "@/lib/formatNumber";
import { SafeStyle } from "@/components/SafeStyle";

type InvoiceSaleItem = {
  stockItemName?: string;
  quantity?: string | number;
  rate?: string | number;
  rateUSD?: string | number;
  configuredPrice?: string | number;
};

export type InvoiceSale = {
  saleDate?: string;
  isCreditSale?: boolean;
  customer?: { name?: string } | null;
  items?: InvoiceSaleItem[];
  location?: { id?: number; whatsappGroupChatId?: unknown };
  voucher?: {
    id?: number;
    voucherNumber?: string;
    customerId?: number;
    exchangeRate?: string | number;
    description?: string | null;
  };
};

export interface InvoiceTemplateProps {
  printRef: React.RefObject<HTMLDivElement | null>;
  savedSale: InvoiceSale | null | undefined;
  printUserName: string;
  selectedCompany: { name?: string | null } | null | undefined;
  exchangeRate: number | null;
  fmtPrint: (val: number | string | null | undefined, prefix?: string) => string;
  fmtPrintCurrency: (val: number | string | null | undefined) => string;
}

export function InvoiceTemplate({
  printRef,
  savedSale,
  printUserName,
  selectedCompany,
  exchangeRate,
  fmtPrint,
  fmtPrintCurrency,
}: InvoiceTemplateProps) {
  return (
    <div style={{ position: "fixed", top: 0, left: "-99999px", width: "680px", pointerEvents: "none", zIndex: -1 }}>
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
          POS INVOICE
        </div>

        {/* Invoice Info - Date/Time left, User right */}
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
          <span>Date: {savedSale?.saleDate}</span>
          <span>User: {printUserName}</span>
        </div>

        {/* Daily Exchange Rate - Only for Mali company, uses transaction's locked rate */}
        {selectedCompany?.name?.toLowerCase().includes("mali") &&
          (savedSale?.voucher?.exchangeRate || exchangeRate) && (
            <div
              style={{
                fontSize: "8pt",
                fontWeight: "700",
                marginBottom: "4px",
                padding: "3px",
                border: "1.5px solid black",
                textAlign: "center",
              }}
            >
              <span style={{ fontWeight: "900" }}>Daily Rate:</span> $1 ={" "}
              {formatNumber(parseFloat(String(savedSale?.voucher?.exchangeRate ?? "")) || exchangeRate || 0)} CFA
            </div>
          )}

        {/* Credit Sale Customer Info */}
        {savedSale?.isCreditSale && savedSale?.customer && (
          <div
            style={{
              fontSize: "8pt",
              fontWeight: "700",
              marginBottom: "4px",
              padding: "3px",
              border: "1.5px solid black",
            }}
          >
            <div style={{ fontWeight: "900" }}>CREDIT SALE</div>
            <div>Customer: {savedSale.customer.name}</div>
          </div>
        )}

        {/* Items Table — NO Tailwind classes; only inline styles so html2canvas renders correctly */}
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "8pt",
            lineHeight: "1.5",
            fontVariantNumeric: "tabular-nums",
            border: "1px solid #999",
            fontFamily: "Arial, Helvetica, sans-serif",
          }}
        >
          <thead>
            <tr style={{ backgroundColor: "#e0e0e0" }}>
              <th
                style={{
                  textAlign: "left",
                  padding: "4px 6px",
                  width: "34%",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                Description
              </th>
              <th
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  width: "7%",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                Qty
              </th>
              <th
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  width: "10%",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                Rate
              </th>
              <th
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  width: "11%",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                Amt
              </th>
              <th
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  width: "11%",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                Config
              </th>
              <th
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  width: "13%",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                P/L Bale
              </th>
              <th
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  width: "14%",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                Total P/L
              </th>
            </tr>
          </thead>
          <tbody>
            {(savedSale?.items ?? []).map((item: InvoiceSaleItem, idx: number) => {
              const itemRateUSD = parseFloat(String(item.rateUSD ?? item.rate ?? 0));
              const itemAmountUSD = parseFloat(String(item.quantity ?? 0)) * itemRateUSD;
              const configuredPrice = parseFloat(String(item.configuredPrice || "0"));
              const plPerBale = itemRateUSD - configuredPrice;
              const totalPL = plPerBale * parseFloat(String(item.quantity ?? 0));
              const plBaleColor = plPerBale > 0 ? "#0a7e1f" : plPerBale < 0 ? "#c2272d" : undefined;
              const totalPLColor = totalPL > 0 ? "#0a7e1f" : totalPL < 0 ? "#c2272d" : undefined;
              return (
                <tr key={idx} style={{ backgroundColor: "#ffffff" }}>
                  <td
                    style={{
                      padding: "4px 6px",
                      verticalAlign: "middle",
                      wordBreak: "break-word",
                      fontWeight: "600",
                      border: "1px solid #bbb",
                    }}
                  >
                    {item.stockItemName}
                  </td>
                  <td
                    style={{
                      textAlign: "center",
                      padding: "4px 6px",
                      verticalAlign: "middle",
                      fontWeight: "600",
                      border: "1px solid #bbb",
                    }}
                  >
                    {fmtPrint(parseFloat(String(item.quantity ?? 0)))}
                  </td>
                  <td
                    style={{
                      textAlign: "center",
                      padding: "4px 6px",
                      verticalAlign: "middle",
                      fontWeight: "600",
                      border: "1px solid #bbb",
                    }}
                  >
                    {fmtPrintCurrency(itemRateUSD)}
                  </td>
                  <td
                    style={{
                      textAlign: "center",
                      padding: "4px 6px",
                      verticalAlign: "middle",
                      fontWeight: "600",
                      border: "1px solid #bbb",
                    }}
                  >
                    {fmtPrintCurrency(itemAmountUSD)}
                  </td>
                  <td
                    style={{
                      textAlign: "center",
                      padding: "4px 6px",
                      verticalAlign: "middle",
                      fontWeight: "600",
                      border: "1px solid #bbb",
                    }}
                  >
                    {fmtPrintCurrency(configuredPrice)}
                  </td>
                  <td
                    style={{
                      textAlign: "center",
                      padding: "4px 6px",
                      verticalAlign: "middle",
                      fontWeight: "600",
                      border: "1px solid #bbb",
                      color: plBaleColor,
                    }}
                  >
                    {fmtPrint(plPerBale, "$")}
                  </td>
                  <td
                    style={{
                      textAlign: "center",
                      padding: "4px 6px",
                      verticalAlign: "middle",
                      fontWeight: "600",
                      border: "1px solid #bbb",
                      color: totalPLColor,
                    }}
                  >
                    {fmtPrint(totalPL, "$")}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ backgroundColor: "#e0e0e0" }}>
              <td style={{ padding: "4px 6px", fontWeight: "900", border: "1px solid #999", verticalAlign: "middle" }}>
                TOTAL
              </td>
              <td
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                {fmtPrint(
                  (savedSale?.items ?? []).reduce(
                    (sum: number, item: InvoiceSaleItem) => sum + parseFloat(String(item.quantity || 0)),
                    0
                  )
                )}
              </td>
              <td style={{ border: "1px solid #999" }}></td>
              <td
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                }}
              >
                {fmtPrintCurrency(
                  (savedSale?.items ?? []).reduce(
                    (sum: number, item: InvoiceSaleItem) =>
                      sum + parseFloat(String(item.quantity)) * parseFloat(String(item.rateUSD || item.rate)),
                    0
                  )
                )}
              </td>
              <td style={{ border: "1px solid #999" }}></td>
              <td style={{ border: "1px solid #999" }}></td>
              <td
                style={{
                  textAlign: "center",
                  padding: "4px 6px",
                  fontWeight: "900",
                  border: "1px solid #999",
                  verticalAlign: "middle",
                  color: (() => {
                    const t = (savedSale?.items ?? []).reduce(
                      (s: number, i: InvoiceSaleItem) =>
                        s +
                        (parseFloat(String(i.rateUSD || i.rate)) - parseFloat(String(i.configuredPrice || "0"))) *
                          parseFloat(String(i.quantity)),
                      0
                    );
                    return t > 0 ? "#0a7e1f" : t < 0 ? "#c2272d" : undefined;
                  })(),
                }}
              >
                {(() => {
                  const t = (savedSale?.items ?? []).reduce(
                    (s: number, i: InvoiceSaleItem) =>
                      s +
                      (parseFloat(String(i.rateUSD || i.rate)) - parseFloat(String(i.configuredPrice || "0"))) *
                        parseFloat(String(i.quantity)),
                    0
                  );
                  return fmtPrint(t, "$");
                })()}
              </td>
            </tr>
          </tfoot>
        </table>

        {/* Total Paid */}
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
          <span>
            {fmtPrintCurrency(
              (savedSale?.items ?? []).reduce((sum: number, item: InvoiceSaleItem) => {
                const rateUSD = parseFloat(String(item.rateUSD ?? item.rate ?? 0));
                return sum + parseFloat(String(item.quantity ?? 0)) * rateUSD;
              }, 0)
            )}
          </span>
        </div>

        {/* Notes - dir=auto handles Arabic RTL automatically */}
        {savedSale?.voucher?.description && (
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
            <span style={{ fontWeight: "900" }}>Note:</span> {savedSale.voucher.description}
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
