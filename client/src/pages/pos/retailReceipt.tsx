import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { money, type RetailSale } from "./retailPosTypes";

export type RetailReceiptPaperWidth = 58 | 80;
const RECEIPT_PAPER_STORAGE_KEY = "retail-pos-receipt-width";

function readPaperWidth(): RetailReceiptPaperWidth {
  try {
    return window.localStorage.getItem(RECEIPT_PAPER_STORAGE_KEY) === "58" ? 58 : 80;
  } catch {
    return 80;
  }
}

// Off-screen (rather than display:none) to measure actual receipt height.
const RECEIPT_CSS = `
#retail-receipt-print-root {
  box-sizing: border-box;
  width: var(--rr-paper-width);
  max-width: var(--rr-paper-width);
  padding: 2.5mm var(--rr-side-padding) 3mm;
  margin: 0;
  background: #fff !important;
  color: #000 !important;
  font-family: "Courier New", Courier, monospace;
  font-size: var(--rr-font-size);
  line-height: 1.35;
  font-weight: 400;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
#retail-receipt-print-root *, #retail-receipt-print-root *::before, #retail-receipt-print-root *::after { box-sizing: border-box; }
#retail-receipt-print-root .rr-center { text-align: center; overflow-wrap: anywhere; }
#retail-receipt-print-root .rr-title { font-weight: 800; font-size: var(--rr-title-size); line-height: 1.2; margin-bottom: 1.5mm; }
#retail-receipt-print-root .rr-rule { width: 100%; border-top: 1px dashed #111; margin: 2.5mm 0; }
#retail-receipt-print-root .rr-line { display: flex; justify-content: space-between; align-items: baseline; gap: 2mm; }
#retail-receipt-print-root .rr-line > :first-child { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
#retail-receipt-print-root .rr-line > :last-child { flex: 0 0 auto; white-space: nowrap; text-align: right; }
#retail-receipt-print-root .rr-item { padding: 1mm 0; break-inside: avoid; page-break-inside: avoid; }
#retail-receipt-print-root .rr-item-name { font-weight: 700; overflow-wrap: anywhere; }
#retail-receipt-print-root .rr-item-details { font-size: 0.88em; overflow-wrap: anywhere; }
#retail-receipt-print-root .rr-total { font-weight: 800; font-size: 1.18em; padding-top: 1.5mm; }
#retail-receipt-print-root .rr-total, #retail-receipt-print-root .rr-payment { font-variant-numeric: tabular-nums; }
#retail-receipt-print-root .rr-muted { font-size: 0.88em; }
#retail-receipt-print-root .rr-footer { padding: 2.5mm 0 1mm; font-weight: 700; }
@media screen {
  #retail-receipt-print-root { display: block !important; position: fixed !important; left: -10000px !important; top: 0 !important; visibility: hidden !important; pointer-events: none !important; }
}
@media print {
  html, body { width: 100% !important; min-width: 0 !important; height: auto !important; margin: 0 !important; padding: 0 !important; background: white !important; }
  body > *:not(#retail-receipt-print-root) { display: none !important; }
  #retail-receipt-print-root { display: block !important; position: static !important; visibility: visible !important; width: var(--rr-paper-width) !important; max-width: var(--rr-paper-width) !important; margin: 0 !important; box-shadow: none !important; }
}
`;

export function RetailReceipt({
  sale,
  companyName,
  locationName,
}: {
  sale: RetailSale;
  companyName?: string;
  locationName?: string;
}) {
  const taxEnabled = Boolean(sale.taxEnabled);
  const hasDiscount = Number(sale.discountTotal ?? 0) > 0;
  const collected = (sale.payments ?? []).reduce(
    (sum, payment) =>
      payment.method === "credit" || payment.method === "store_credit"
        ? sum
        : sum + (payment.paymentType === "refund" ? -payment.amount : payment.amount),
    0
  );
  const customerCreditIssued = (sale.payments ?? []).reduce(
    (sum, payment) =>
      payment.method === "store_credit" && payment.paymentType === "refund" ? sum + payment.amount : sum,
    0
  );
  const onAccount = (sale.payments ?? []).reduce(
    (sum, payment) =>
      payment.method !== "credit" ? sum : sum + (payment.paymentType === "refund" ? -payment.amount : payment.amount),
    0
  );
  return (
    <div data-no-translate>
      <div className="rr-center rr-title">{companyName ?? "Receipt"}</div>
      {locationName && <div className="rr-center">{locationName}</div>}
      <div className="rr-center rr-muted">Receipt #{sale.id}</div>
      <div className="rr-center rr-muted">{new Date(sale.createdAt).toLocaleString()}</div>
      <div className="rr-center rr-muted">Customer: {sale.customerName || "Walk-in"}</div>
      <div className="rr-rule" />
      {sale.items.map((item) => {
        const paidUnit = item.grossUnitPrice ?? item.unitPrice;
        const listUnit = item.originalUnitPrice ?? item.unitPrice;
        const discounted = paidUnit < listUnit - 0.000001 || Number(item.lineDiscountAmount ?? 0) > 0;
        return (
          <div key={item.id} className="rr-item">
            <div className="rr-item-name">{item.brand} · {item.name}</div>
            <div className="rr-item-details">{item.color} / {item.size}</div>
            <div className="rr-item-details rr-muted">{item.barcode}</div>
            <div className="rr-line">
              <span>
                {item.quantity} × {money(paidUnit)}
                {discounted && <span className="rr-muted"> (was {money(listUnit)})</span>}
              </span>
              <span>{money(item.lineTotal ?? item.quantity * paidUnit)}</span>
            </div>
            {discounted && (
              <div className="rr-line rr-muted">
                <span>
                  Discount
                  {item.lineDiscountType === "percent"
                    ? ` ${item.lineDiscountValue ?? 0}%`
                    : item.lineDiscountType === "promotion"
                      ? " (promotion)"
                      : item.lineDiscountType === "override"
                        ? " (override)"
                        : ""}
                </span>
                <span>-{money(item.lineDiscountAmount ?? 0)}</span>
              </div>
            )}
            {taxEnabled && Number(item.taxAmount ?? 0) !== 0 && (
              <div className="rr-line rr-muted">
                <span>{sale.taxLabel || "Tax"}</span>
                <span>{money(item.taxAmount ?? 0)}</span>
              </div>
            )}
            {item.returnedQuantity > 0 && (
              <div className="rr-line">
                <span>Returned {item.returnedQuantity}</span>
                <span>-{money(item.returnedQuantity * paidUnit)}</span>
              </div>
            )}
          </div>
        );
      })}
      <div className="rr-rule" />
      <div className="rr-line">
        <span>Subtotal</span>
        <span>{money(sale.listSubtotal ?? sale.totalAmount)}</span>
      </div>
      {hasDiscount && (
        <div className="rr-line">
          <span>Discount</span>
          <span>-{money(sale.discountTotal ?? 0)}</span>
        </div>
      )}
      {taxEnabled && (
        <div className="rr-line">
          <span>
            {sale.taxLabel || "Tax"}
            {sale.taxRate ? ` (${Number((sale.taxRate * 100).toFixed(2))}%)` : ""}
          </span>
          <span>{money(sale.taxAmount ?? 0)}</span>
        </div>
      )}
      <div className="rr-line rr-total">
        <span>TOTAL</span>
        <span>{money(sale.totalAmount)}</span>
      </div>
      {sale.payments?.length ? (
        <>
          <div className="rr-rule" />
          {sale.payments.map((payment) => (
            <div className="rr-line" key={payment.id}>
              <span>
                {payment.method === "store_credit"
                  ? "CREDIT TO CUSTOMER ACCOUNT"
                  : payment.method === "credit"
                    ? payment.paymentType === "refund"
                      ? "REVERSED CREDIT"
                      : "ON ACCOUNT"
                    : payment.paymentType === "refund"
                      ? `REFUND ${payment.method.toUpperCase()}`
                      : payment.method.toUpperCase()}
              </span>
              <span>
                {payment.paymentType === "refund" ? "-" : ""}
                {money(payment.amount)}
              </span>
            </div>
          ))}
          {customerCreditIssued > 0 && (
            <div className="rr-line">
              <span>CUSTOMER CREDIT ISSUED</span>
              <span>{money(customerCreditIssued)}</span>
            </div>
          )}
          {sale.payments.some((payment) => payment.method === "credit") && (
            <>
              <div className="rr-line">
                <span>NET COLLECTED</span>
                <span>{money(collected)}</span>
              </div>
              <div className="rr-line">
                <strong>UNPAID ON ACCOUNT</strong>
                <strong>{money(Math.max(0, onAccount))}</strong>
              </div>
            </>
          )}
          {sale.payments
            .filter(
              (payment) => payment.paymentType === "payment" && payment.method === "cash" && payment.changeAmount > 0
            )
            .map((payment) => (
              <div className="rr-line" key={`change-${payment.id}`}>
                <span>CHANGE</span>
                <span>{money(payment.changeAmount)}</span>
              </div>
            ))}
        </>
      ) : null}
      {sale.approvedByName && <div className="rr-center rr-muted">Discount approved by {sale.approvedByName}</div>}
      {sale.status !== "completed" && <div className="rr-center">*** {sale.status.toUpperCase()} ***</div>}
      <div className="rr-rule" />
      <div className="rr-center rr-footer">Thank you for shopping!</div>
    </div>
  );
}

/** Prints on thermal roll paper (80mm default, optional persistent 58mm). */
export function useRetailReceiptPrinter(companyName?: string, locationName?: string) {
  const [job, setJob] = useState<{ sale: RetailSale; width: RetailReceiptPaperWidth } | null>(null);
  const [paperWidth, setPaperWidth] = useState<RetailReceiptPaperWidth>(readPaperWidth);

  const changePaperWidth = (width: RetailReceiptPaperWidth) => {
    setPaperWidth(width);
    try {
      window.localStorage.setItem(RECEIPT_PAPER_STORAGE_KEY, String(width));
    } catch {
      // Printing also works if the browser prevents preference storage.
    }
  };

  useEffect(() => {
    if (!job) return;
    const style = document.createElement("style");
    style.setAttribute("data-retail-receipt-print", "true");
    style.textContent = RECEIPT_CSS;
    document.head.appendChild(style);

    // A real page height is required: @page { size: 80mm auto } is invalid
    // in Chromium, causing the browser to silently fall back to A4.
    // The offscreen receipt has the actual thermal width for measuring wraps.
    const finish = () => setJob((current) => (current === job ? null : current));
    window.addEventListener("afterprint", finish);
    const frame = window.requestAnimationFrame(() => {
      const root = document.getElementById("retail-receipt-print-root");
      if (!root) {
        finish();
        return;
      }
      const heightMm = root.getBoundingClientRect().height * 25.4 / 96;
      const paperHeightMm = Math.max(45, Math.ceil(heightMm + 4));
      style.textContent = RECEIPT_CSS + "\n@page { size: " + job.width + "mm " + paperHeightMm + "mm; margin: 0; }";
      window.print();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("afterprint", finish);
      style.remove();
    };
  }, [job]);

  const printReceipt = (sale: RetailSale) => setJob({ sale, width: paperWidth });
  const portal = job
    ? createPortal(
        <div
          id="retail-receipt-print-root"
          style={{
            "--rr-paper-width": job.width + "mm",
            "--rr-side-padding": job.width === 80 ? "3.5mm" : "2.5mm",
            "--rr-font-size": job.width === 80 ? "10pt" : "8.5pt",
            "--rr-title-size": job.width === 80 ? "14pt" : "12pt",
          } as CSSProperties}
        >
          <RetailReceipt sale={job.sale} companyName={companyName} locationName={locationName} />
        </div>,
        document.body
      )
    : null;

  return { printReceipt, portal, paperWidth, setPaperWidth: changePaperWidth };
}
