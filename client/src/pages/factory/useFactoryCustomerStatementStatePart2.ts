// Extracted from ./FactoryCustomerStatement.tsx to keep that module under the source-size cap.
import { useMemo } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import * as XLSX from "xlsx-js-style";
import {
  downloadPriceListTemplate,
  parsePriceListRows,
  type PriceListLine,
} from "./factorycustomerstatement/statementHelpers";
import { useFactoryCustomerStatementStatePart1 } from "./useFactoryCustomerStatementStatePart1";

export function useFactoryCustomerStatementState() {
  const {
    activeCustomerTab,
    addPriceDestination,
    customerId,
    deletePriceMutation,
    draftNote,
    fileInputRef,
    filterDateFrom,
    filterDateTo,
    filterDestination,
    formatDisplayDate,
    isLoading,
    navigate,
    newCode,
    newDestination,
    newPrice,
    priceDestination,
    priceDestinationsQuery,
    priceEdits,
    priceListQuery,
    recordChanges,
    rowNotes,
    saveNoteMutation,
    savePricesMutation,
    savingRowNote,
    selectPriceDestination,
    setDraftNote,
    setFilterDateFrom,
    setFilterDateTo,
    setFilterDestination,
    setNewCode,
    setNewDestination,
    setNewPrice,
    setPriceEdits,
    setRequestedCustomerTab,
    setRowNotes,
    setSavingRowNote,
    showPriceListTab,
    showStatementTab,
    statement,
    toast,
  } = useFactoryCustomerStatementStatePart1();
  const {
    filteredHistory,
    handleExcelUpload,
    handlePriceListTemplateDownload,
    handleSavePrices,
    hasFilters,
    hasPriceEdits,
    saveRowNote,
    totals,
  } = useFactoryCustomerStatementStatePart2({
    customerId,
    filterDateFrom,
    filterDateTo,
    filterDestination,
    newCode,
    newPrice,
    priceDestination,
    priceEdits,
    recordChanges,
    savePricesMutation,
    setSavingRowNote,
    statement,
    toast,
  });
  return {
    activeCustomerTab,
    addPriceDestination,
    customerId,
    deletePriceMutation,
    draftNote,
    fileInputRef,
    filterDateFrom,
    filterDateTo,
    filterDestination,
    filteredHistory,
    formatDisplayDate,
    handleExcelUpload,
    handlePriceListTemplateDownload,
    handleSavePrices,
    hasFilters,
    hasPriceEdits,
    isLoading,
    navigate,
    newCode,
    newDestination,
    newPrice,
    priceDestination,
    priceDestinationsQuery,
    priceEdits,
    priceListQuery,
    recordChanges,
    rowNotes,
    saveNoteMutation,
    savePricesMutation,
    saveRowNote,
    savingRowNote,
    selectPriceDestination,
    setDraftNote,
    setFilterDateFrom,
    setFilterDateTo,
    setFilterDestination,
    setNewCode,
    setNewDestination,
    setNewPrice,
    setPriceEdits,
    setRequestedCustomerTab,
    setRowNotes,
    showPriceListTab,
    showStatementTab,
    statement,
    totals,
  };
}

function useFactoryCustomerStatementStatePart2({
  customerId,
  filterDateFrom,
  filterDateTo,
  filterDestination,
  newCode,
  newPrice,
  priceDestination,
  priceEdits,
  recordChanges,
  savePricesMutation,
  setSavingRowNote,
  statement,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useFactoryCustomerStatementStatePart1>>,
  | "customerId"
  | "filterDateFrom"
  | "filterDateTo"
  | "filterDestination"
  | "newCode"
  | "newPrice"
  | "priceDestination"
  | "priceEdits"
  | "recordChanges"
  | "savePricesMutation"
  | "setSavingRowNote"
  | "statement"
  | "toast"
>) {
  const saveRowNote = async (entryId: number | string, note: string) => {
    // Voucher-entry rows have string IDs ("ve-N") — they have no customerBalances record to update
    if (typeof entryId === "string" || !recordChanges.allowed) return;
    const original = statement?.balanceHistory.find((e) => e.id === entryId)?.rowNote ?? "";
    if (note === original) return;
    setSavingRowNote(entryId);
    try {
      await apiRequest("PATCH", `/api/factory/customers/${customerId}/balance/${entryId}/note`, { rowNote: note });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
    } catch {
      toast({ title: "Failed to save row note", variant: "destructive" });
    } finally {
      setSavingRowNote(null);
    }
  };

  const filteredHistory = useMemo(() => {
    if (!statement?.balanceHistory) return [];
    return statement.balanceHistory.filter((entry) => {
      if (filterDestination) {
        const dest = entry.destination?.toLowerCase() ?? "";
        if (!dest.includes(filterDestination.toLowerCase())) return false;
      }
      if (filterDateFrom && entry.transactionDate) {
        if (entry.transactionDate.toString().slice(0, 10) < filterDateFrom) return false;
      }
      if (filterDateTo && entry.transactionDate) {
        if (entry.transactionDate.toString().slice(0, 10) > filterDateTo) return false;
      }
      return true;
    });
  }, [statement?.balanceHistory, filterDestination, filterDateFrom, filterDateTo]);

  const totals = useMemo(() => {
    let totalBales = 0;
    let totalAmountDebit = 0;
    let totalAmountCredit = 0;
    let totalKg = 0;
    for (const entry of filteredHistory) {
      totalAmountDebit += parseFloat(entry.debitAmount || "0");
      totalAmountCredit += parseFloat(entry.creditAmount || "0");
      if (entry.totalQtyBales != null) totalBales += entry.totalQtyBales;
      if (entry.totalWeightKg != null) totalKg += entry.totalWeightKg;
    }
    return { totalBales, totalAmountDebit, totalAmountCredit, totalKg };
  }, [filteredHistory]);

  const hasFilters = filterDestination || filterDateFrom || filterDateTo;

  const handlePriceListTemplateDownload = async () => {
    try {
      await downloadPriceListTemplate();
    } catch {
      toast({ title: "Failed to download price-list template", variant: "destructive" });
    }
  };

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !priceDestination) return;
    // Capture the scope before FileReader completes so an import cannot land
    // in whichever destination happens to be selected later.
    const destination = priceDestination;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
        const lines = parsePriceListRows(rows);
        if (lines.length === 0) {
          toast({
            title: "No valid rows found",
            description: "Excel must have columns: article_code, price",
            variant: "destructive",
          });
          return;
        }
        savePricesMutation.mutate({ destination, lines });
      } catch {
        toast({ title: "Failed to read file", variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const handleSavePrices = () => {
    if (!priceDestination) return;
    // Save only edited/new rows: resending stale unchanged prices can overwrite
    // a newer explicit save from another screen.
    const lines: PriceListLine[] = [];
    for (const [articleCode, value] of Object.entries(priceEdits)) {
      const price = Number(value);
      if (!Number.isFinite(price) || price <= 0) {
        toast({ title: `Enter a valid positive price for ${articleCode}`, variant: "destructive" });
        return;
      }
      lines.push({ articleCode, pricePerBale: price });
    }
    if (newCode.trim() && newPrice) {
      const price = Number(newPrice);
      if (!Number.isFinite(price) || price <= 0) {
        toast({ title: "Enter a valid positive new price", variant: "destructive" });
        return;
      }
      lines.push({ articleCode: newCode.trim(), pricePerBale: price });
    }
    if (lines.length === 0) {
      toast({ title: "No valid prices to save", variant: "destructive" });
      return;
    }
    savePricesMutation.mutate({ destination: priceDestination, lines });
  };

  const hasPriceEdits = Object.keys(priceEdits).length > 0 || (newCode.trim() !== "" && newPrice !== "");
  return {
    filteredHistory,
    handleExcelUpload,
    handlePriceListTemplateDownload,
    handleSavePrices,
    hasFilters,
    hasPriceEdits,
    saveRowNote,
    totals,
  };
}
