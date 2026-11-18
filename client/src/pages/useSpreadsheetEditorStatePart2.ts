// Extracted from ./SpreadsheetEditor.tsx to keep that module under the source-size cap.
import { useEffect } from "react";
import { excelToFortune } from "@/lib/excelImport";
import { arrayBufferToBase64 } from "@/lib/excelSync";
import { defaultBlankSheets, indexToColLetter } from "./SpreadsheetEditorFortuneToXlsx";
import { useSpreadsheetEditorStatePart1 } from "./useSpreadsheetEditorStatePart1";

export function useSpreadsheetEditorStatePart2({
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
}: Pick<
  Awaited<ReturnType<typeof useSpreadsheetEditorStatePart1>>,
  | "containerRef"
  | "createMutation"
  | "currentDataRef"
  | "hasInteractedRef"
  | "openSheetId"
  | "saveStatus"
  | "saveTimerRef"
  | "seqRef"
  | "seqTimerRef"
  | "setOpenSheetId"
  | "setSheetName"
  | "toast"
  | "updateMutation"
  | "workbookRef"
>) {
  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Implemented in capture phase so we intercept before Fortune Sheet's own
  // onKeyDown handler, and preventDefault stops unwanted browser defaults.
  //
  // Shortcuts supported:
  //   Alt + =               → AutoSum (finds contiguous range above)
  //   Alt+H  →  D  →  R    → Delete selected row(s)
  //   Alt+H  →  D  →  C    → Delete selected column(s)
  //   Alt+I  →  R           → Insert row above selection
  //   Alt+I  →  C           → Insert column left of selection
  //
  // Multi-key sequences time out after 1.5 s of inactivity.
  useEffect(() => {
    if (openSheetId === null) return;

    const resetSeq = () => {
      seqRef.current = "";
      if (seqTimerRef.current) clearTimeout(seqTimerRef.current);
    };

    const armTimer = () => {
      if (seqTimerRef.current) clearTimeout(seqTimerRef.current);
      seqTimerRef.current = setTimeout(resetSeq, 1500);
    };

    const getSel = () => {
      const sel = workbookRef.current?.getSelection?.();
      return Array.isArray(sel) && sel.length > 0 ? sel[0] : null;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const alt = e.altKey;

      // ── Alt + = : AutoSum ──────────────────────────────────────────────
      if (alt && key === "=") {
        e.preventDefault();
        resetSeq();
        const sel = getSel();
        if (!sel) return;
        const r = sel.row[0];
        const c = sel.column[0];
        // Walk upward to find the contiguous non-empty range
        let startRow = r - 1;
        while (startRow >= 0) {
          const val = workbookRef.current?.getCellValue?.(startRow, c);
          if (val === null || val === undefined || val === "") break;
          startRow--;
        }
        startRow++; // first non-empty row
        const col = indexToColLetter(c);
        const formula = startRow < r ? `=SUM(${col}${startRow + 1}:${col}${r})` : `=SUM()`;
        hasInteractedRef.current = true;
        workbookRef.current?.setCellValue?.(r, c, formula);
        return;
      }

      // ── Multi-key sequences ────────────────────────────────────────────
      const seq = seqRef.current;

      // Ignore plain modifier keypresses so they don't corrupt the sequence
      if (["alt", "control", "shift", "meta"].includes(key)) return;

      if (seq === "" && alt && key === "h") {
        e.preventDefault();
        seqRef.current = "alt-h";
        armTimer();
        return;
      }

      if (seq === "" && alt && key === "i") {
        e.preventDefault();
        seqRef.current = "alt-i";
        armTimer();
        return;
      }

      if (seq === "alt-h" && key === "d") {
        e.preventDefault();
        seqRef.current = "alt-h-d";
        armTimer();
        return;
      }

      if (seq === "alt-h-d" && key === "r") {
        e.preventDefault();
        resetSeq();
        const sel = getSel();
        if (!sel) return;
        hasInteractedRef.current = true;
        workbookRef.current?.deleteRowOrColumn?.("row", sel.row[0], sel.row[1]);
        return;
      }

      if (seq === "alt-h-d" && key === "c") {
        e.preventDefault();
        resetSeq();
        const sel = getSel();
        if (!sel) return;
        hasInteractedRef.current = true;
        workbookRef.current?.deleteRowOrColumn?.("column", sel.column[0], sel.column[1]);
        return;
      }

      if (seq === "alt-i" && key === "r") {
        e.preventDefault();
        resetSeq();
        const sel = getSel();
        if (!sel) return;
        hasInteractedRef.current = true;
        workbookRef.current?.insertRowOrColumn?.("row", sel.row[0], 1, "lefttop");
        return;
      }

      if (seq === "alt-i" && key === "c") {
        e.preventDefault();
        resetSeq();
        const sel = getSel();
        if (!sel) return;
        hasInteractedRef.current = true;
        workbookRef.current?.insertRowOrColumn?.("column", sel.column[0], 1, "lefttop");
        return;
      }

      // Key doesn't advance any sequence — reset
      if (seq !== "") resetSeq();
    };

    const el = containerRef.current;
    el?.addEventListener("keydown", handleKeyDown, true);
    return () => {
      el?.removeEventListener("keydown", handleKeyDown, true);
      if (seqTimerRef.current) clearTimeout(seqTimerRef.current);
      seqRef.current = "";
    };
  }, [openSheetId, containerRef, hasInteractedRef, seqRef, seqTimerRef, workbookRef]);

  const handleOpen = (id: number, name: string) => {
    setOpenSheetId(id);
    setSheetName(name);
  };

  const handleBack = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      if (openSheetId !== null && currentDataRef.current.length > 0 && saveStatus !== "saved") {
        updateMutation.mutate({
          id: openSheetId,
          fields: { data: currentDataRef.current },
        });
      }
    }
    setOpenSheetId(null);
    currentDataRef.current = [];
  };

  const handleNew = () => {
    const data = defaultBlankSheets();
    createMutation.mutate({ name: "Untitled Spreadsheet", data });
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const buf = await file.arrayBuffer();
      const sheets = await excelToFortune(buf);
      const rawXlsx = arrayBufferToBase64(buf);
      const name = file.name.replace(/\.(xlsx|xls)$/i, "");
      createMutation.mutate({ name, data: { mode: "excel", rawXlsx, sheets } });
    } catch {
      toast({
        title: "Could not read file",
        description: "Make sure it is a valid .xlsx file.",
        variant: "destructive",
      });
    }
  };
  return { handleBack, handleNew, handleOpen, handleUpload };
}
