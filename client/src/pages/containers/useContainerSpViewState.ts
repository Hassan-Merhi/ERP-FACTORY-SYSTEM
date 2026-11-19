// Extracted from ./ContainerSpView.tsx to keep that module under the source-size cap.
import {
  columnsFromOperationalRows,
  exportOperationalWorkbook,
  type OperationalExcelSheet,
} from "@/lib/operationalExcelExport";
import { spContainerInvoiceChargeLines } from "@shared/spContainerInvoiceCharges";
import { useContainerSpViewStatePart1, type ContainerSpViewProps } from "./useContainerSpViewStatePart1";
export type { ContainerSpViewProps } from "./useContainerSpViewStatePart1";

export function useContainerSpViewState({
  spContainersList,
  allContainers,
  suppliers,
  searchTerm,
  setSearchTerm,
  isSpLoading,
  setLocation,
  formatDisplayDate,
}: ContainerSpViewProps) {
  const {
    toast,
    formatAmount,
    selectedContainer,
    setSelectedContainer,
    reason,
    setReason,
    statusFilter,
    setStatusFilter,
    setSupplierFilter,
    supplierFilter,
    recordChanges,
    canCancel,
    cancelContainer,
    allSpItems,
    visibleContainers,
    otwContainers,
    offloadedContainers,
    totalValue,
    supplierNames,
    filtered,
  } = useContainerSpViewStatePart1({ spContainersList, allContainers, suppliers, searchTerm });

  const exportContainers = async (full: boolean) => {
    try {
      const summary = filtered.map((c) => ({
        "Container Number": c.subName || c.displayName,
        "Invoice / PO": c._source === "sp" ? c.displayName : "",
        Supplier: c.supplierName,
        Status: c.statusLabel,
        "Import / Invoice Date": formatDisplayDate(c.date),
        "Total (USD)": c.totalUsd,
        Source: c._source === "sp" ? "Supplier Partner" : "ERP",
      }));
      const outputSheets: OperationalExcelSheet[] = [
        {
          name: "Containers",
          rows: summary,
          columns: columnsFromOperationalRows(summary, {
            orderedHeaders: [
              "Container Number",
              "Invoice / PO",
              "Supplier",
              "Status",
              "Import / Invoice Date",
              "Total (USD)",
              "Source",
            ],
            types: { "Total (USD)": "money" },
          }),
        },
      ];
      if (full) {
        const detailRows: Record<string, string | number>[] = [];
        for (const c of filtered) {
          if (c._source === "sp") {
            const native = spContainersList.find((item) => item.id === c.id);
            if (!native) continue;
            const factor = 1 - parseFloat(native.discountPct ?? "0") / 100;
            for (const line of native.lines ?? []) {
              const quantity = parseFloat(line.qty ?? "0");
              const rate = parseFloat(line.unitRateUsd ?? "0") * factor;
              detailRows.push({
                Container: native.containerNumber || "",
                Invoice: native.invoiceNumber || "",
                Supplier: native.supplierName || "",
                "Item Name": line.description || line.articleCode,
                Quantity: quantity,
                "Rate (USD)": rate,
                "Total (USD)": quantity * rate,
              });
            }
            for (const charge of spContainerInvoiceChargeLines(native)) {
              detailRows.push({
                Container: native.containerNumber || "",
                Invoice: native.invoiceNumber || "",
                Supplier: native.supplierName || "",
                "Item Name": charge.description,
                Quantity: 1,
                "Rate (USD)": charge.amountUsd,
                "Total (USD)": charge.amountUsd,
              });
            }
            detailRows.push({
              Container: native.containerNumber || "",
              Invoice: native.invoiceNumber || "",
              Supplier: native.supplierName || "",
              "Item Name": "Recorded Invoice Total",
              Quantity: Number(native.totalQty || 0),
              "Rate (USD)": 0,
              "Total (USD)": Number(native.invoiceTotalUsd || 0),
            });
          } else {
            const response = await fetch("/api/containers/" + c.id, { credentials: "include" });
            if (!response.ok) throw new Error("Cannot export ERP container " + c.displayName);
            const detail = (await response.json()) as {
              pos?: { items?: { itemName?: string; quantity?: string; rate?: string; lineTotal?: string }[] }[];
            };
            for (const po of detail.pos ?? []) {
              for (const item of po.items ?? []) {
                detailRows.push({
                  Container: c.displayName,
                  Invoice: "",
                  Supplier: c.supplierName,
                  "Item Name": item.itemName || "",
                  Quantity: Number(item.quantity || 0),
                  "Rate (USD)": Number(item.rate || 0),
                  "Total (USD)": Number(item.lineTotal || 0),
                });
              }
            }
          }
        }
        const details = detailRows.length ? detailRows : [{ Message: "No line items" }];
        outputSheets.push({
          name: "Line Items",
          rows: details,
          columns: columnsFromOperationalRows(details, {
            orderedHeaders: detailRows.length
              ? ["Container", "Invoice", "Supplier", "Item Name", "Quantity", "Rate (USD)", "Total (USD)"]
              : ["Message"],
            types: {
              Quantity: "decimal",
              "Rate (USD)": "money",
              "Total (USD)": "money",
            },
          }),
        });
      }
      await exportOperationalWorkbook({
        title: full ? "Containers — Full Details" : "Containers",
        fileName: full ? "containers_full_export.xlsx" : "containers.xlsx",
        filters: [
          { label: "Search", value: searchTerm || "All" },
          { label: "Status", value: statusFilter },
        ],
        sheets: outputSheets,
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };
  return {
    allSpItems,
    canCancel,
    cancelContainer,
    exportContainers,
    filtered,
    formatAmount,
    formatDisplayDate,
    isSpLoading,
    offloadedContainers,
    otwContainers,
    reason,
    recordChanges,
    searchTerm,
    selectedContainer,
    setLocation,
    setReason,
    setSearchTerm,
    setSelectedContainer,
    setStatusFilter,
    setSupplierFilter,
    statusFilter,
    supplierFilter,
    supplierNames,
    totalValue,
    visibleContainers,
  };
}
