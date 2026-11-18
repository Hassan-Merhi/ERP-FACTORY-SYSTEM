import { Copy } from "lucide-react";
import { ReportExportMenu, REPORT_EXPORT_LABELS, type ReportExportOption } from "@/components/export/ReportExportMenu";
import { erpReportFileName, exportErpReportRowsExcel } from "@/erp-core/erpReportExports";
import { rentalPaymentDateLabel } from "@/properties/config/rentalPaymentPresentation";
import { cashCents } from "../paymentsReceiptMath";
import type { PaymentRow } from "../../RentalPaymentsLog";

const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The visible payment rows as worksheet rows. Each amount keeps its recorded
 * currency in its own column; nothing is converted or totalled here.
 * `cashOnly` mirrors the Properties table, which shows voucher-backed cash.
 */
export function rentalPaymentExportRows(rows: readonly PaymentRow[], cashOnly: boolean) {
  return rows.map((p) => ({
    Date: rentalPaymentDateLabel(p.paymentDate),
    "Client / Tenant": p.tenantName ?? "",
    Unit: p.unitNumber ?? "",
    Location: p.locationGroup ?? "",
    [cashOnly ? "Cash Received" : "Amount"]: cashOnly ? cashCents(p) / 100 : Number(p.amount),
    Currency: p.currency?.trim() || "Unverified",
    "For Month": `${MONTH_NAMES[p.forMonth] ?? ""} ${p.forYear}`.trim(),
    Notes: p.notes ?? "",
    Voucher: p.voucherId ? `#${p.voucherId}` : "No entry",
  }));
}

type Props = {
  rows: readonly PaymentRow[];
  cashOnly: boolean;
  disabled: boolean;
  companyName?: string;
  testIdPrefix: string;
  /** Properties only: clipboard copy of the filtered or reconciled history. */
  canCopy?: boolean;
  fullHistory?: boolean;
  onCopy?: () => void;
};

/** The Payments Log export menu, placed in the PageHeader actions in every module. */
export function RentalPaymentsExportMenu({
  rows,
  cashOnly,
  disabled,
  companyName,
  testIdPrefix,
  canCopy = false,
  fullHistory = false,
  onCopy,
}: Props) {
  const options: ReportExportOption[] = [
    {
      id: "excel",
      kind: "excel",
      label: REPORT_EXPORT_LABELS.excel,
      disabled: disabled || rows.length === 0,
      testId: `export-${testIdPrefix}-payments-excel`,
      onSelect: () =>
        exportErpReportRowsExcel({
          rows: rentalPaymentExportRows(rows, cashOnly),
          sheetName: "Rental Payments",
          fileName: erpReportFileName("Rental_Payments_Log", "xlsx"),
          universalDesign: true,
          companyName,
        }),
    },
  ];
  if (onCopy) {
    options.push({
      id: "copy",
      label: fullHistory ? "Copy Full History" : "Copy Results",
      icon: <Copy className="mr-2 h-4 w-4" aria-hidden="true" />,
      disabled: !canCopy,
      testId: fullHistory ? "button-properties-copy-reconciled-history" : "button-properties-copy-payment-history",
      onSelect: onCopy,
    });
  }
  return <ReportExportMenu options={options} size="sm" data-testid={`button-${testIdPrefix}-payments-export`} />;
}
