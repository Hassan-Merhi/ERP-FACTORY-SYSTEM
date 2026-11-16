// Extracted from ./SpreadsheetEditor.tsx to keep that module under the source-size cap.
import { downloadBlob } from "@/lib/downloadBlob";
import type { Sheet as FortuneSheet } from "@fortune-sheet/core";
import { ensureCelldata } from "./spreadsheetEditorModel";
import { isExcelMode, syncFortuneToXlsx } from "@/lib/excelSync";
import { defaultBlankSheets, fortuneToXlsx } from "./SpreadsheetEditorFortuneToXlsx";
import { useSpreadsheetEditorStatePart1 } from "./useSpreadsheetEditorStatePart1";
import { useSpreadsheetEditorStatePart2 } from "./useSpreadsheetEditorStatePart2";

export function useSpreadsheetEditorState() {
  const {
    containerRef,
    createMutation,
    currentDataRef,
    deleteMutation,
    deleteTarget,
    editingName,
    fileInputRef,
    handleChange,
    hasInteractedRef,
    library,
    libraryLoading,
    markInteracted,
    nameInputRef,
    openSheetId,
    openedSheet,
    rawXlsxRef,
    saveStatus,
    saveTimerRef,
    seqRef,
    seqTimerRef,
    setDeleteTarget,
    setEditingName,
    setOpenSheetId,
    setSheetName,
    setTempName,
    sheetLoading,
    sheetName,
    tempName,
    toast,
    updateMutation,
    workbookRef,
  } = useSpreadsheetEditorStatePart1();
  const { handleBack, handleNew, handleOpen, handleUpload } = useSpreadsheetEditorStatePart2({
    containerRef,
    createMutation,
    currentDataRef,
    hasInteractedRef,
    openSheetId,
    saveStatus,
    saveTimerRef,
    seqRef,
    seqTimerRef,
    setOpenSheetId,
    setSheetName,
    toast,
    updateMutation,
    workbookRef,
  });
  const { confirmRename, handleDownload, initialData, startRename } = useSpreadsheetEditorStatePart3({
    currentDataRef,
    nameInputRef,
    openSheetId,
    openedSheet,
    rawXlsxRef,
    setEditingName,
    setSheetName,
    setTempName,
    sheetName,
    tempName,
    toast,
    updateMutation,
  });
  return {
    confirmRename,
    containerRef,
    createMutation,
    deleteMutation,
    deleteTarget,
    editingName,
    fileInputRef,
    handleBack,
    handleChange,
    handleDownload,
    handleNew,
    handleOpen,
    handleUpload,
    initialData,
    library,
    libraryLoading,
    markInteracted,
    nameInputRef,
    openSheetId,
    openedSheet,
    saveStatus,
    setDeleteTarget,
    setEditingName,
    setTempName,
    sheetLoading,
    sheetName,
    startRename,
    tempName,
    workbookRef,
  };
}

function useSpreadsheetEditorStatePart3({
  currentDataRef,
  nameInputRef,
  openSheetId,
  openedSheet,
  rawXlsxRef,
  setEditingName,
  setSheetName,
  setTempName,
  sheetName,
  tempName,
  toast,
  updateMutation,
}: Pick<
  Awaited<ReturnType<typeof useSpreadsheetEditorStatePart1>>,
  | "currentDataRef"
  | "nameInputRef"
  | "openSheetId"
  | "openedSheet"
  | "rawXlsxRef"
  | "setEditingName"
  | "setSheetName"
  | "setTempName"
  | "sheetName"
  | "tempName"
  | "toast"
  | "updateMutation"
>) {
  const handleDownload = async () => {
    const d = openedSheet?.data;
    const currentSheets: FortuneSheet[] =
      currentDataRef.current.length > 0
        ? currentDataRef.current
        : isExcelMode(d)
          ? d.sheets
          : Array.isArray(d)
            ? d
            : [];

    if (rawXlsxRef.current) {
      // Excel mode: sync Fortune Sheet edits back into the original workbook,
      // preserving advanced features (tables, condFmt, data validation, named ranges)
      try {
        const buf = await syncFortuneToXlsx(rawXlsxRef.current, currentSheets);
        const blob = new Blob([buf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        downloadBlob(blob, `${sheetName}.xlsx`);
      } catch {
        toast({ title: "Export failed", variant: "destructive" });
      }
    } else {
      // Native mode: existing xlsx-js-style export path (unchanged)
      if (!currentSheets.length) return;
      const xlsxModule = await import("xlsx-js-style");
      const XLSX = xlsxModule.default ?? xlsxModule;
      const wb = fortuneToXlsx(currentSheets, XLSX);
      XLSX.writeFile(wb, `${sheetName}.xlsx`);
    }
  };

  const startRename = () => {
    setTempName(sheetName);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.select(), 10);
  };

  const confirmRename = () => {
    const trimmed = tempName.trim();
    if (trimmed && trimmed !== sheetName && openSheetId !== null) {
      setSheetName(trimmed);
      updateMutation.mutate({ id: openSheetId, fields: { name: trimmed } });
    }
    setEditingName(false);
  };

  // Build the initial data passed to Fortune Sheet.
  // Excel mode: use the ExcelJS-extracted sheets stored in data.sheets.
  // Native mode: use data directly (FortuneSheet[]).
  // Always run through ensureCelldata to convert dense→sparse for Fortune Sheet init.
  const initialData: FortuneSheet[] = (() => {
    if (!openedSheet?.data) return defaultBlankSheets();
    const d = openedSheet.data;
    const sheets = isExcelMode(d) ? d.sheets : Array.isArray(d) ? d : [];
    return sheets.length > 0 ? sheets.map(ensureCelldata) : defaultBlankSheets();
  })();
  return { confirmRename, handleDownload, initialData, startRename };
}
