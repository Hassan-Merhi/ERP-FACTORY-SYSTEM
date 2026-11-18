import { RowsExportMenu } from "@/components/export/RowsExportMenu";

export interface PendingLoadingExportRow {
  id: number;
  customerId: number;
  customerName: string;
  totalQtyBales: number;
  totalWeightKg: string | null;
  proformaIdUsed: number | null;
  proformaName: string | null;
  loadingStartedAt: string | null;
  containerNotes: string | null;
}

interface PendingLoadingsExportProps {
  /** The loadings the cards show, in the same (customer-grouped) order. */
  rows: readonly PendingLoadingExportRow[];
  /** The "Started" text the cards show (date and time). */
  formatStarted: (value: string | null) => string;
}

/** Excel export of the Pending Loadings cards under the current search, customer and sort. */
export function PendingLoadingsExport({ rows, formatStarted }: PendingLoadingsExportProps) {
  return (
    <RowsExportMenu
      title="Pending Loadings"
      rows={rows}
      columns={[
        { header: "Customer", value: (load) => load.customerName || `Customer #${load.customerId}` },
        { header: "Loading #", value: (load) => load.id, type: "number" },
        {
          header: "Proforma",
          value: (load) =>
            load.proformaIdUsed ? load.proformaName || `Proforma #${load.proformaIdUsed}` : "No proforma linked",
        },
        { header: "Started", value: (load) => formatStarted(load.loadingStartedAt) },
        { header: "Bales scanned", value: (load) => load.totalQtyBales || 0, type: "number" },
        {
          header: "Weight (kg)",
          value: (load) => (load.totalWeightKg ? Number.parseFloat(load.totalWeightKg) : null),
          type: "number",
        },
        { header: "Note", value: (load) => load.containerNotes },
      ]}
      resource="factory.customer_orders"
      className="h-10 rounded-xl"
      data-testid="button-export-pending-loadings"
    />
  );
}
