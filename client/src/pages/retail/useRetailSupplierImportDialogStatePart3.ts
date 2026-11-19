// Extracted from ./useRetailSupplierImportDialogStatePart2.ts
import { sizeLimitLabel, spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
import { parseRetailSupplierSpreadsheetFile } from "./retailSupplierImportSpreadsheet";
import { useRetailSupplierImportDialogStatePart1 } from "./useRetailSupplierImportDialogStatePart1";

export function useRetailSupplierImportDialogStatePart3({
  selectedCompany,
  setBusy,
  setFileError,
  setFileName,
  setImportKey,
  setPostingError,
  setPurchaseResult,
  setRows,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useRetailSupplierImportDialogStatePart1>>,
  | "selectedCompany"
  | "setBusy"
  | "setFileError"
  | "setFileName"
  | "setImportKey"
  | "setPostingError"
  | "setPurchaseResult"
  | "setRows"
  | "toast"
>) {
  const handleSpreadsheet = async (file?: File) => {
    setFileName("");
    setRows([]);
    setFileError("");
    setPurchaseResult(null);
    setPostingError("");
    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
    if (!file) return;
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      setFileError("Choose an .xlsx or .csv spreadsheet");
      return;
    }
    if (file.size > spreadsheetImportLimitBytes(selectedCompany?.role)) {
      setFileError(
        `Spreadsheet must be ${sizeLimitLabel(spreadsheetImportLimitBytes(selectedCompany?.role))} or smaller`
      );
      return;
    }
    setBusy(true);
    try {
      const parsed = await parseRetailSupplierSpreadsheetFile(file);
      setRows(parsed);
      setFileName(file.name);
      const invalid = parsed.filter((row) => row.errors.length).length;
      toast({
        title: invalid ? "Spreadsheet needs corrections" : "Spreadsheet preview ready",
        description: invalid
          ? `${invalid} row(s) have validation errors. No stock was changed.`
          : `${parsed.length} row(s) checked. No stock or ledger changes were made.`,
      });
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not read spreadsheet");
    } finally {
      setBusy(false);
    }
  };
  return { handleSpreadsheet };
}
