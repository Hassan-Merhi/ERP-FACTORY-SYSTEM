import { RowsExportMenu, type RowsExportColumn } from "@/components/export/RowsExportMenu";

import { getFactoryInvoiceDate, getOverloadedBales, getRemainingBales } from "./invoiceCalculations";
import type { InvoiceColumnKey } from "./InvoiceOrderRow";
import type { CustomerOrder } from "./types";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  LOADING: "Loading",
  PENDING_VERIFICATION: "Verified",
  VERIFIED: "Verified",
  FINALIZED: "Finalized",
  CANCELLED: "Cancelled",
};

const positive = (value: string | null | undefined) => {
  const parsed = parseFloat(value || "0");
  return parsed > 0 ? parsed : null;
};

type OrderColumns = RowsExportColumn<CustomerOrder>[];
type ColumnsFor = (formatDate: (date: string) => string) => OrderColumns;

const OPTIONAL_COLUMNS: Record<InvoiceColumnKey, ColumnsFor> = {
  loading: () => [{ header: "Loading #", value: (order) => `#${order.id}` }],
  proforma: () => [{ header: "Proforma", value: (order) => order.proformaName }],
  container: () => [{ header: "Container", value: (order) => order.containerNumber }],
  bookingInfo: () => [{ header: "Booking Info", value: (order) => order.bookingInfo }],
  agent: () => [{ header: "Agent", value: (order) => order.agentName }],
  destination: () => [{ header: "Destination", value: (order) => order.destination }],
  notes: () => [{ header: "Notes", value: (order) => order.containerNotes }],
  date: (formatDate) => [
    {
      header: "Date",
      value: (order) => {
        const date = getFactoryInvoiceDate(order);
        return date ? formatDate(date) : "-";
      },
    },
  ],
  status: () => [{ header: "Status", value: (order) => STATUS_LABELS[order.status] ?? order.status }],
  bales: () => [{ header: "Bales", value: (order) => order.totalQtyBales, type: "number" }],
  weight: () => [{ header: "Weight (kg)", value: (order) => positive(order.totalWeightKg), type: "number" }],
  remaining: () => [
    {
      header: "Remaining",
      value: (order) => {
        if (parseFloat(order.proformaExpectedBales || "0") <= 0) return null;
        const remaining = getRemainingBales(order);
        if (remaining > 0) return remaining;
        const overloaded = getOverloadedBales(order);
        return overloaded > 0 ? `+${overloaded}` : "Done";
      },
    },
  ],
  extras: () => [
    { header: "Freight (USD)", value: (order) => positive(order.freightAmount), type: "number" },
    { header: "Other charges (USD)", value: (order) => positive(order.otherChargesTotal), type: "number" },
  ],
  total: () => [{ header: "Total (USD)", value: (order) => parseFloat(order.grandTotal || "0"), type: "number" }],
};

const COLUMN_ORDER: InvoiceColumnKey[] = [
  "loading",
  "proforma",
  "container",
  "bookingInfo",
  "agent",
  "destination",
  "notes",
  "date",
  "status",
  "bales",
  "weight",
  "remaining",
  "extras",
  "total",
];

interface InvoiceListExportProps {
  /** Orders in the order the table lists them (customer groups, then their orders). */
  orders: readonly CustomerOrder[];
  isColumnVisible: (key: InvoiceColumnKey) => boolean;
  formatDisplayDate: (date: string) => string;
  period: { from?: string; to?: string };
}

/** Excel export of the Factory Invoices table: the filtered orders and the visible columns. */
export function InvoiceListExport({ orders, isColumnVisible, formatDisplayDate, period }: InvoiceListExportProps) {
  const columns: OrderColumns = [
    { header: "Customer", value: (order) => order.customerName },
    ...COLUMN_ORDER.filter(isColumnVisible).flatMap((key) => OPTIONAL_COLUMNS[key](formatDisplayDate)),
  ];
  return (
    <RowsExportMenu
      title="Factory Invoices"
      rows={orders}
      columns={columns}
      resource="factory.customer_orders"
      period={period}
      className="h-9 rounded-lg text-xs"
      data-testid="button-export-invoices"
    />
  );
}
