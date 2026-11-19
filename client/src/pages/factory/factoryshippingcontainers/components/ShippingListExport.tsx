import { RowsExportMenu, type RowsExportColumn } from "@/components/export/RowsExportMenu";

import type { DisplayRow, ShippingColId } from "../types";
import { fmtDate, statusLabel } from "../utils";

const COLUMNS: { id: ShippingColId; column: RowsExportColumn<DisplayRow> }[] = [
  { id: "orderDate", column: { header: "Order Date", value: (r) => fmtDate(r.orderDate) } },
  { id: "invoiceNumber", column: { header: "Invoice #", value: (r) => r.invoiceNumber } },
  { id: "clientName", column: { header: "Client", value: (r) => r.clientName } },
  { id: "status", column: { header: "Status", value: (r) => statusLabel(r.status) } },
  { id: "containerNumber", column: { header: "Container #", value: (r) => r.containerNumber } },
  { id: "destination", column: { header: "Destination", value: (r) => r.destination } },
  { id: "eta", column: { header: "ETA", value: (r) => fmtDate(r._trackedEta ?? r.eta) } },
  { id: "arrived", column: { header: "Arrived", value: (r) => fmtDate(r.containerArrivedDate) } },
  {
    id: "finalized",
    column: { header: "Finalized", value: (r) => (r.finalizedDate ? fmtDate(r.finalizedDate) : "Not finalized") },
  },
  { id: "shippingCo", column: { header: "Shipping Co.", value: (r) => r.shippingCompany } },
  { id: "documents", column: { header: "Documents", value: (r) => r.documentCount, type: "number" } },
  {
    id: "containerCost",
    column: {
      header: "Container Cost (USD)",
      value: (r) => (r.grandTotal ? Number(r.grandTotal) : null),
      type: "number",
    },
  },
  { id: "ciNumber", column: { header: "CI No.", value: (r) => r.ciNumber } },
  { id: "note", column: { header: "Note", value: (r) => r.note } },
  { id: "anything", column: { header: "Anything", value: (r) => r.anything } },
];

interface ShippingListExportProps {
  /** Every row the filters keep (all pages of the active list). */
  rows: readonly DisplayRow[];
  colVis: Record<ShippingColId, boolean>;
  period: { from?: string; to?: string };
}

/** Excel export of the active shipping containers table: filtered rows, visible data columns. */
export function ShippingListExport({ rows, colVis, period }: ShippingListExportProps) {
  return (
    <RowsExportMenu
      title="Shipping Containers"
      rows={rows}
      columns={COLUMNS.filter(({ id }) => colVis[id]).map(({ column }) => column)}
      resource="factory.customer_orders"
      period={period}
      className="h-9 rounded-lg text-xs"
      data-testid="button-export-shipping"
    />
  );
}
