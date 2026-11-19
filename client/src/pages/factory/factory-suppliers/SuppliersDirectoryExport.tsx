import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import type { SuppliersModel } from "./FactorySuppliersDirectoryMetric";

type DirectorySupplier = SuppliersModel["filteredTopLevel"][number];

/** Excel export of the supplier cards on screen (same order, same balance sign as the cards). */
export function SuppliersDirectoryExport({
  model,
  suppliers,
}: {
  model: SuppliersModel;
  suppliers: readonly DirectorySupplier[];
}) {
  return (
    <RowsExportMenu
      title="Brokers and Suppliers"
      rows={suppliers}
      columns={[
        { header: "Supplier", value: (supplier) => supplier.name },
        {
          header: "Role",
          value: (supplier) =>
            model.subAccountsByParent[supplier.id]?.length || supplier.isBroker ? "Broker" : "Supplier",
        },
        { header: "Containers", value: (supplier) => supplier.totalContainers, type: "number" },
        {
          header: "OTW",
          value: (supplier) =>
            supplier.otwByCurrency
              ? Object.values(supplier.otwByCurrency).reduce((left, right) => left + right, 0)
              : supplier.pendingContainers || 0,
          type: "number",
        },
        {
          header: "Weight (kg)",
          value: (supplier) => parseFloat(supplier.totalKg || "0") || null,
          type: "number",
        },
        {
          header: "Last container",
          value: (supplier) => (supplier.lastContainerDate ? model.formatDate(supplier.lastContainerDate) : null),
        },
        {
          // Positive = we owe them (the card shows it as a negative, red amount).
          header: "Balance (USD equivalent)",
          value: (supplier) => (supplier.usdEquivalentBalance == null ? null : -Number(supplier.usdEquivalentBalance)),
          type: "number",
        },
        {
          header: "Missing FX rates",
          value: (supplier) =>
            supplier.usdEquivalentBalance == null ? (supplier.usdEquivalentMissingRates || []).join(", ") : null,
        },
      ]}
      resource="factory.accounting"
      size="default"
      data-testid="button-export-suppliers-directory"
    />
  );
}
