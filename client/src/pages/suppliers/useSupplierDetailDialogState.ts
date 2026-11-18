// Extracted from ./SupplierDetailDialog.tsx to keep that module under the source-size cap.
import type { Company } from "@/contexts/CompanyContext";
import type { SupplierLedgerRow, SupplierPurchaseOrder, SupplierWithStats } from "./supplierDisplay";
import {
  computeLedgerKpis,
  currentLedgerBalance,
  displayedLedgerRows,
  enrichPurchaseOrderTotals,
  filterLedgerRowsByDate,
  filterPurchaseOrdersByDate,
  hiddenPaymentsCount,
  matchesSupplierDestination,
  purchaseOrderGrandTotal,
  type SupplierDateFilter,
} from "./ledgerSummaries";

export type SupplierDetailTab = "transactions" | "purchase-orders";

export interface SupplierDetailDialogProps {
  supplier: SupplierWithStats | null;
  companies: Company[];
  formatAmount: (amount: number) => string;
  companyFilter: string;
  onCompanyFilterChange: (value: string) => void;
  destinationFilter: string;
  onDestinationFilterChange: (value: string) => void;
  dateFilter: SupplierDateFilter;
  onDateFilterChange: (value: SupplierDateFilter) => void;
  hidePayments: boolean;
  onToggleHidePayments: () => void;
  unifiedLedger: SupplierLedgerRow[];
  ledgerLoading: boolean;
  purchaseOrders: SupplierPurchaseOrder[];
  posLoading: boolean;
  dialogTab: SupplierDetailTab;
  onDialogTabChange: (tab: SupplierDetailTab) => void;
  onClose: () => void;
  onExport: () => void;
  canExport?: boolean;
  exportUnavailableReason?: string;
  onTransactionClick: (txn: SupplierLedgerRow) => void;
  onPOClick: (po: SupplierPurchaseOrder) => void;
  onContainerClick: (po: { companyId: number | null; containerId?: number | null }) => void;
}

export function useSupplierDetailDialogState({
  supplier,
  companies,
  formatAmount,
  companyFilter,
  onCompanyFilterChange,
  destinationFilter,
  onDestinationFilterChange,
  dateFilter,
  onDateFilterChange,
  hidePayments,
  onToggleHidePayments,
  unifiedLedger,
  ledgerLoading,
  purchaseOrders,
  posLoading,
  dialogTab,
  onDialogTabChange,
  onClose,
  onExport,
  canExport = true,
  exportUnavailableReason,
  onTransactionClick,
  onPOClick,
  onContainerClick,
}: SupplierDetailDialogProps) {
  const matchesDestination = (id: number | null | undefined) => matchesSupplierDestination(id, destinationFilter);
  const openingEntry = destinationFilter === "all" ? unifiedLedger.find((t) => t.type === "opening") : undefined;
  const ledgerRows = unifiedLedger.filter((t) => t.type !== "opening");
  const filteredLedgerRows = filterLedgerRowsByDate(ledgerRows, dateFilter).filter((row) =>
    matchesDestination(row.destinationCompanyId)
  );
  const { txCount, totalPurchases, totalPayments, totalPurchasesQty } = computeLedgerKpis(filteredLedgerRows);
  // A single destination cannot inherit the combined supplier opening balance.
  // In this mode display the period's net movement, not a misleading global balance.
  const currentBalance =
    destinationFilter === "all"
      ? currentLedgerBalance(unifiedLedger)
      : filteredLedgerRows.reduce((sum, row) => sum + Number(row.credit || 0) - Number(row.debit || 0), 0);
  const runningDestinationNet = new Map<SupplierLedgerRow, number>();
  let destinationNet = 0;
  for (const row of filteredLedgerRows) {
    destinationNet += Number(row.credit || 0) - Number(row.debit || 0);
    runningDestinationNet.set(row, destinationNet);
  }
  const displayedRows = displayedLedgerRows(filteredLedgerRows, hidePayments);
  const hiddenCount = hiddenPaymentsCount(filteredLedgerRows, hidePayments);
  const sortedPOs = enrichPurchaseOrderTotals(
    filterPurchaseOrdersByDate(purchaseOrders, dateFilter).filter((po) => matchesDestination(po.destinationCompanyId))
  );
  const grandTotal = purchaseOrderGrandTotal(sortedPOs);
  const destinations = new Map<number, string>();
  for (const row of [...purchaseOrders, ...ledgerRows]) {
    if (row.destinationCompanyId != null) {
      destinations.set(
        row.destinationCompanyId,
        row.destinationCompanyName ||
          companies.find((company) => company.id === row.destinationCompanyId)?.name ||
          "Unknown"
      );
    }
  }
  const destinationOptions = [...destinations.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const hasUnassigned = ledgerRows.some((row) => row.destinationCompanyId == null);
  return {
    canExport,
    companies,
    companyFilter,
    currentBalance,
    dateFilter,
    destinationFilter,
    destinationOptions,
    dialogTab,
    displayedRows,
    exportUnavailableReason,
    filteredLedgerRows,
    formatAmount,
    grandTotal,
    hasUnassigned,
    hiddenCount,
    hidePayments,
    ledgerLoading,
    onClose,
    onCompanyFilterChange,
    onContainerClick,
    onDateFilterChange,
    onDestinationFilterChange,
    onDialogTabChange,
    onExport,
    onPOClick,
    onToggleHidePayments,
    onTransactionClick,
    openingEntry,
    posLoading,
    runningDestinationNet,
    sortedPOs,
    supplier,
    totalPayments,
    totalPurchases,
    totalPurchasesQty,
    txCount,
    unifiedLedger,
  };
}
