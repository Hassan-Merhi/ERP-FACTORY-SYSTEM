import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { money, type RetailSale } from "./retailPosTypes";

const RECEIPT_CSS = `
#retail-receipt-print-root { font-family: "Courier New", monospace; color: #000; background: #fff; width: 72mm; padding: 3mm 4mm; font-size: 9pt; }
#retail-receipt-print-root .rr-center { text-align: center; }
#retail-receipt-print-root .rr-title { font-weight: 700; font-size: 11pt; }
#retail-receipt-print-root .rr-rule { border-top: 1px dashed #000; margin: 2mm 0; }
#retail-receipt-print-root .rr-line { display: flex; justify-content: space-between; gap: 2mm; }
#retail-receipt-print-root .rr-item { margin-bottom: 1.5mm; }
#retail-receipt-print-root .rr-total { font-weight: 700; font-size: 11pt; }
@media screen { #retail-receipt-print-root { display: none; } }
@media print {
  @page { size: 80mm auto; margin: 0; }
  html, body { background: #fff !important; }
  body > *:not(#retail-receipt-print-root) { display: none !important; }
  #retail-receipt-print-root { display: block; }
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
  return (
    <div data-no-translate>
      <div className="rr-center rr-title">{companyName ?? "Receipt"}</div>
      {locationName && <div className="rr-center">{locationName}</div>}
      <div className="rr-center">
        #{sale.id} · {new Date(sale.createdAt).toLocaleString()}
      </div>
      <div className="rr-rule" />
      {sale.items.map((item) => (
        <div key={item.id} className="rr-item">
          <div>
            {item.brand} · {item.name}
          </div>
          <div>
            {item.color} / {item.size} · {item.barcode}
          </div>
          <div className="rr-line">
            <span>
              {item.quantity} × {money(item.unitPrice)}
            </span>
            <span>{money(item.grossAmount ?? item.quantity * item.unitPrice)}</span>
          </div>
          {(item.discountAmount ?? 0) > 0 && (
            <div className="rr-line">
              <span>Discount</span>
              <span>-{money(item.discountAmount ?? 0)}</span>
            </div>
          )}
          {(item.taxAmount ?? 0) > 0 && (
            <div className="rr-line">
              <span>Tax</span>
              <span>{money(item.taxAmount ?? 0)}</span>
            </div>
          )}
          {(item.totalAmount ?? null) != null && (
            <div className="rr-line">
              <span>Line total</span>
              <span>{money(item.totalAmount ?? 0)}</span>
            </div>
          )}
          {item.returnedQuantity > 0 && (
            <div className="rr-line">
              <span>Returned {item.returnedQuantity}</span>
              <span>-{money(item.returnedAmount ?? 0)}</span>
            </div>
          )}
        </div>
      ))}
      <div className="rr-rule" />
      <div className="rr-line">
        <span>Subtotal</span>
        <span>{money(sale.subtotalAmount ?? sale.totalAmount)}</span>
      </div>
      {(sale.discountAmount ?? 0) > 0 && (
        <div className="rr-line">
          <span>Discount</span>
          <span>-{money(sale.discountAmount ?? 0)}</span>
        </div>
      )}
      {(sale.taxAmount ?? 0) > 0 && (
        <div className="rr-line">
          <span>Tax</span>
          <span>{money(sale.taxAmount ?? 0)}</span>
        </div>
      )}
      <div className="rr-line rr-total">
        <span>TOTAL</span>
        <span>{money(sale.totalAmount)}</span>
      </div>
      {(sale.payments ?? [])
        .filter((payment) => payment.operationType === "sale")
        .map((payment) => (
          <div key={payment.id} className="rr-line">
            <span>{payment.method.replaceAll("_", " ").toUpperCase()}</span>
            <span>{money(payment.amount)}</span>
          </div>
        ))}
      {(sale.payments ?? []).some((payment) => payment.operationType === "sale") && (
        <>
          <div className="rr-line">
            <span>Paid</span>
            <span>{money(sale.paidAmount ?? 0)}</span>
          </div>
          {(sale.changeDue ?? 0) > 0 && (
            <div className="rr-line">
              <span>Change</span>
              <span>{money(sale.changeDue ?? 0)}</span>
            </div>
          )}
        </>
      )}
      {(sale.refundedAmount ?? 0) > 0 && (
        <div className="rr-line">
          <span>Refunded</span>
          <span>{money(sale.refundedAmount ?? 0)}</span>
        </div>
      )}
      {sale.status !== "completed" && <div className="rr-center">*** {sale.status.toUpperCase()} ***</div>}
      <div className="rr-rule" />
      <div className="rr-center">Thank you</div>
    </div>
  );
}

/** Prints an 80 mm receipt through the browser print dialog (thermal receipt printers or any printer). */
export function useRetailReceiptPrinter(companyName?: string, locationName?: string) {
  const [sale, setSale] = useState<RetailSale | null>(null);

  useEffect(() => {
    if (!sale) return;
    const style = document.createElement("style");
    style.setAttribute("data-retail-receipt-print", "true");
    style.textContent = RECEIPT_CSS;
    document.head.appendChild(style);
    const finish = () => setSale(null);
    window.addEventListener("afterprint", finish, { once: true });
    const timer = window.setTimeout(() => window.print(), 100);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", finish);
      style.remove();
    };
  }, [sale]);

  const portal = sale
    ? createPortal(
        <div id="retail-receipt-print-root">
          <RetailReceipt sale={sale} companyName={companyName} locationName={locationName} />
        </div>,
        document.body
      )
    : null;

  return { printReceipt: setSale, portal };
}
