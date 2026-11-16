// Extracted from ./SpreadsheetEditor.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { downloadBlob } from "@/lib/downloadBlob";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Sheet as FortuneSheet } from "@fortune-sheet/core";
import type { WorkbookInstance } from "@fortune-sheet/react";
import { ensureCelldata, type SpreadsheetListItem } from "./spreadsheetEditorModel";
import { excelToFortune } from "@/lib/excelImport";
import { arrayBufferToBase64, isExcelMode, type SpreadsheetData, syncFortuneToXlsx } from "@/lib/excelSync";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { defaultBlankSheets, fortuneToXlsx, indexToColLetter } from "./SpreadsheetEditorFortuneToXlsx";

export function useSpreadsheetEditorState() {
  const { toast } = useToast();
  const [openSheetId, setOpenSheetId] = useState<number | null>(null);
  const [sheetName, setSheetName] = useState("Untitled Spreadsheet");
  const [editingName, setEditingName] = useState(false);
  const [tempName, setTempName] = useState("");
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentDataRef = useRef<FortuneSheet[]>([]);
  const hasInteractedRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const workbookRef = useRef<WorkbookInstance | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Caches the base64 rawXlsx for Excel-mode sheets so autosave and download can use it
  const rawXlsxRef = useRef<string>("");
  // Keyboard shortcut sequence state: tracks partial multi-key sequences
  const seqRef = useRef<string>("");
  const seqTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: library = [], isLoading: libraryLoading } = useQuery<SpreadsheetListItem[]>({
    queryKey: ["/api/spreadsheets"],
  });

  const { data: openedSheet, isLoading: sheetLoading } = useQuery({
    queryKey: ["/api/spreadsheets", openSheetId],
    queryFn: async () => {
      const res = await fetch(`/api/spreadsheets/${openSheetId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load spreadsheet");
      return res.json();
    },
    enabled: openSheetId !== null,
  });

  const createMutation = useMutation({
    mutationFn: async (payload: { name: string; data: unknown }) => {
      const res = await apiRequest("POST", "/api/spreadsheets", payload);
      return res.json();
    },
    onSuccess: (sheet) => {
      queryClient.setQueryData(["/api/spreadsheets", sheet.id], sheet);
      queryClient.invalidateQueries({ queryKey: ["/api/spreadsheets"], exact: true });
      setOpenSheetId(sheet.id);
      setSheetName(sheet.name);
      setSaveStatus("saved");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error creating spreadsheet", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, fields }: { id: number; fields: { name?: string; data?: unknown } }) => {
      const res = await apiRequest("PATCH", `/api/spreadsheets/${id}`, fields);
      return res.json();
    },
    onSuccess: () => {
      setSaveStatus("saved");
      queryClient.invalidateQueries({ queryKey: ["/api/spreadsheets"], exact: true });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      setSaveStatus("unsaved");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/spreadsheets/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/spreadsheets"] });
      if (openSheetId === deleteTarget) setOpenSheetId(null);
      setDeleteTarget(null);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error deleting spreadsheet", variant: "destructive" });
    },
  });

  const scheduleSave = useCallback(
    (sheets: FortuneSheet[]) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        if (openSheetId !== null) {
          setSaveStatus("saving");
          const data: SpreadsheetData = rawXlsxRef.current
            ? { mode: "excel", rawXlsx: rawXlsxRef.current, sheets }
            : sheets;
          updateMutation.mutate({ id: openSheetId, fields: { data } });
        }
      }, 1500);
    },
    [openSheetId, updateMutation]
  );

  const handleChange = useCallback(
    (data: FortuneSheet[]) => {
      // Only save data that results from a real user interaction.
      // Fortune Sheet fires onChange multiple times during initialization
      // (at ~50ms AND again at ~200-500ms for formula/dependency computation).
      // Blocking all saves until the user physically clicks or types ensures
      // we never overwrite correct uploaded data with Fortune Sheet's init state.
      if (!hasInteractedRef.current) return;
      currentDataRef.current = data;
      setSaveStatus("unsaved");
      scheduleSave(data);
    },
    [scheduleSave]
  );

  const markInteracted = useCallback(() => {
    hasInteractedRef.current = true;
  }, []);

  useEffect(() => {
    currentDataRef.current = [];
    hasInteractedRef.current = false;
    setSaveStatus("saved");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, [openSheetId]);

  // Cache rawXlsx whenever the opened sheet changes (Excel mode vs native mode)
  useEffect(() => {
    if (openedSheet && isExcelMode(openedSheet.data)) {
      rawXlsxRef.current = openedSheet.data.rawXlsx;
    } else {
      rawXlsxRef.current = "";
    }
  }, [openedSheet]);

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
  }, [openSheetId]);

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
        toast({ title: "Download failed", variant: "destructive" });
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
