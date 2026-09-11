import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Workbook } from "@fortune-sheet/react";
import { PageHeader } from "@/components/PageHeader";
import "@fortune-sheet/react/dist/index.css";
import type { Sheet as FortuneSheet, Cell as FortuneCell, CellWithRowAndCol } from "@fortune-sheet/core";
import type { CellObject as XlsxCellObject, ColInfo, RowInfo, WorkSheet as XlsxWorkSheet } from "xlsx-js-style";
import type { WorkbookInstance } from "@fortune-sheet/react";
import { excelToFortune } from "@/lib/excelImport";
import { isExcelMode, type SpreadsheetData, arrayBufferToBase64, syncFortuneToXlsx } from "@/lib/excelSync";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, Upload, Download, FileSpreadsheet, Trash2, Check, Loader2, Pencil } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Fortune Sheet REQUIRES celldata (sparse format) for initialization.
// Its initSheetData() reads celldata, builds an expanded matrix, then
// OVERWRITES sheet.data — so passing dense data without celldata always
// produces a blank sheet.

// ─── Border style maps (Fortune Sheet number ↔ xlsx-js-style name) ──────────
const FS_BORDER: Record<string, string> = {
  "1": "thin",
  "2": "hair",
  "3": "dotted",
  "4": "dashed",
  "5": "dashDot",
  "6": "dashDotDot",
  "7": "double",
  "8": "medium",
  "9": "mediumDashed",
  "10": "mediumDashDot",
  "11": "mediumDashDotDot",
  "12": "slantDashDot",
  "13": "thick",
};
// ─── Fortune Sheet alignment encoding ───────────────────────────────────────
// Horizontal: toolbar reveals value: 1=left, 0=center, 2=right
const FS_HT: Record<string, string> = { "0": "center", "1": "left", "2": "right" };
// Vertical:   toolbar reveals value: 1=top, 0=middle, 2=bottom
const FS_VT: Record<string, string> = { "0": "center", "1": "top", "2": "bottom" };

// Fortune Sheet's onChange delivers sheets in dense `data` format.
// When re-opening a saved sheet, convert back to sparse `celldata` so
// Fortune Sheet's initSheetData() correctly populates the grid.
function ensureCelldata(sheet: FortuneSheet): FortuneSheet {
  if (sheet.celldata !== undefined) return sheet; // already sparse
  if (!Array.isArray(sheet.data)) return sheet;
  const celldata: CellWithRowAndCol[] = [];
  for (let r = 0; r < sheet.data.length; r++) {
    const row = sheet.data[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== null && v !== undefined) {
        celldata.push({ r, c, v });
      }
    }
  }
  const { data: _data, ...rest } = sheet;
  return { ...rest, celldata };
}

/** One spreadsheet entry in the /api/spreadsheets list. */
interface SpreadsheetListItem {
  id: number;
  name: string;
  updatedAt: string;
  createdBy?: string | null;
}

/** Border record Fortune Sheet stores on a cell (not part of its public Cell type). */
type FortuneCellBorder = Partial<Record<"l" | "r" | "t" | "b", { style?: string | number; color?: string }>>;

/** Cell shape this editor reads, including the app-written border record. */
type EditorCell = FortuneCell & { b?: FortuneCellBorder };

/** xlsx-js-style cell, extended with this editor's formula sentinel type. */
type XlCell = Omit<XlsxCellObject, "t"> & { t: XlsxCellObject["t"] | "f" };

interface XlsxFontStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sz?: number;
  color?: { rgb: string };
  name?: string;
}

interface XlsxCellStyleParts {
  font?: XlsxFontStyle;
  fill?: { patternType: string; fgColor: { rgb: string } };
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean };
  border?: Record<string, { style: string; color: { rgb: string } }>;
}

function fortuneToXlsx(sheets: FortuneSheet[], XLSX: typeof import("xlsx-js-style")) {
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws: XlsxWorkSheet = {};
    let maxR = 0;
    let maxC = 0;

    const writeCell = (r: number, c: number, v: EditorCell | null) => {
      if (!v) return;
      const hasValue = v.v !== undefined || v.m !== undefined || v.f;
      if (!hasValue) return;

      const addr = XLSX.utils.encode_cell({ r, c });
      const val = v.v ?? v.m;
      const xlCell: XlCell = {
        v: val,
        t: v.f ? "f" : typeof val === "number" ? "n" : typeof val === "boolean" ? "b" : "s",
        w: v.m !== undefined ? String(v.m) : val !== undefined ? String(val) : "",
      };

      // Formula: stored without "=" in both SheetJS and Fortune Sheet
      if (v.f) xlCell.f = v.f;

      // Number format
      const fa = v.ct?.fa;
      if (fa && fa !== "General" && fa !== "@") xlCell.z = fa;

      // Style object
      const s: XlsxCellStyleParts = {};

      // Font
      if (v.bl || v.it || v.un || v.cl || v.fs || v.fc || v.ff) {
        s.font = {};
        if (v.bl) s.font.bold = true;
        if (v.it) s.font.italic = true;
        if (v.un) s.font.underline = true;
        if (v.cl) s.font.strike = true;
        if (v.fs) s.font.sz = Number(v.fs);
        if (v.fc) s.font.color = { rgb: v.fc.replace("#", "").toUpperCase() };
        if (v.ff) s.font.name = String(v.ff);
      }

      // Fill / background
      if (v.bg) {
        s.fill = { patternType: "solid", fgColor: { rgb: v.bg.replace("#", "").toUpperCase() } };
      }

      // Alignment
      const ht = FS_HT[String(v.ht)];
      const vt = FS_VT[String(v.vt)];
      const wrap = String(v.tb) === "2";
      if (ht || vt || wrap) {
        s.alignment = {};
        if (ht) s.alignment.horizontal = ht;
        if (vt) s.alignment.vertical = vt;
        if (wrap) s.alignment.wrapText = true;
      }

      // Borders
      if (v.b) {
        const sides: Record<string, string> = { l: "left", r: "right", t: "top", b: "bottom" };
        const border: Record<string, { style: string; color: { rgb: string } }> = {};
        for (const [fs, xl] of Object.entries(sides)) {
          const bd = v.b[fs as keyof FortuneCellBorder];
          if (bd?.style) {
            border[xl] = {
              style: FS_BORDER[String(bd.style)] || "thin",
              color: { rgb: (bd.color || "#000000").replace("#", "").toUpperCase() },
            };
          }
        }
        if (Object.keys(border).length > 0) s.border = border;
      }

      if (Object.keys(s).length > 0) xlCell.s = s;

      ws[addr] = xlCell;
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, c);
    };

    const sheetData = sheet.data;
    if (sheetData && Array.isArray(sheetData) && sheetData.length > 0) {
      for (let r = 0; r < sheetData.length; r++) {
        if (!sheetData[r]) continue;
        for (let c = 0; c < sheetData[r].length; c++) writeCell(r, c, sheetData[r][c]);
      }
    } else {
      for (const cell of sheet.celldata || []) writeCell(cell.r, cell.c, cell.v);
    }

    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });

    const cfg = sheet.config || {};

    // Merged cells
    if (cfg.merge) {
      ws["!merges"] = Object.values(cfg.merge).map((m) => ({
        s: { r: m.r, c: m.c },
        e: { r: m.r + m.rs - 1, c: m.c + m.cs - 1 },
      }));
    }

    // Column widths + hidden
    if (cfg.columnlen || cfg.colhidden) {
      const cMax = Math.max(
        ...Object.keys(cfg.columnlen || {}).map(Number),
        ...Object.keys(cfg.colhidden || {}).map(Number),
        maxC
      );
      const xlCols: ColInfo[] = Array.from({ length: cMax + 1 }, () => ({}));
      for (const [ci, w] of Object.entries(cfg.columnlen || {})) {
        xlCols[Number(ci)].wpx = w;
        xlCols[Number(ci)].wch = Math.round((w / 7) * 100) / 100;
      }
      for (const ci of Object.keys(cfg.colhidden || {})) xlCols[Number(ci)].hidden = true;
      ws["!cols"] = xlCols;
    }

    // Row heights + hidden
    if (cfg.rowlen || cfg.rowhidden) {
      const rMax = Math.max(
        ...Object.keys(cfg.rowlen || {}).map(Number),
        ...Object.keys(cfg.rowhidden || {}).map(Number),
        maxR
      );
      const xlRows: RowInfo[] = Array.from({ length: rMax + 1 }, () => ({}));
      for (const [ri, h] of Object.entries(cfg.rowlen || {})) {
        xlRows[Number(ri)].hpx = h;
        xlRows[Number(ri)].hpt = Math.round((h / 1.333) * 100) / 100;
      }
      for (const ri of Object.keys(cfg.rowhidden || {})) xlRows[Number(ri)].hidden = true;
      ws["!rows"] = xlRows;
    }

    // Auto filter
    const fs = sheet.filter_select;
    if (fs) {
      const c1 = XLSX.utils.encode_col(fs.column[0]);
      const c2 = XLSX.utils.encode_col(fs.column[1]);
      ws["!autofilter"] = { ref: `${c1}${fs.row[0] + 1}:${c2}${fs.row[1] + 1}` };
    }

    XLSX.utils.book_append_sheet(wb, ws, sheet.name || "Sheet");
  }
  return wb;
}

function defaultBlankSheets(): FortuneSheet[] {
  return [
    {
      id: "1",
      name: "Sheet1",
      status: 1,
      order: 0,
      celldata: [],
      row: 50,
      column: 26,
    } as FortuneSheet,
  ];
}

function formatRelativeTime(ts: string | Date): string {
  const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Reorder toolbar so merge, colors, borders, conditionFormat, filter are
// visible before the wide font-name / font-size selectors.
const TOOLBAR_ITEMS = [
  "undo",
  "redo",
  "|",
  "bold",
  "italic",
  "underline",
  "strike-through",
  "|",
  "font-color",
  "background",
  "border",
  "|",
  "merge-cell",
  "|",
  "horizontal-align",
  "vertical-align",
  "text-wrap",
  "|",
  "conditionFormat",
  "filter",
  "freeze",
  "|",
  "font",
  "|",
  "font-size",
  "|",
  "format-painter",
  "clear-format",
  "|",
  "currency-format",
  "percentage-format",
  "number-decrease",
  "number-increase",
  "format",
  "text-rotation",
  "link",
  "image",
  "comment",
  "quick-formula",
  "dataVerification",
  "screenshot",
  "search",
];

/** Convert 0-based column index to Excel letter(s): 0→A, 25→Z, 26→AA … */
function indexToColLetter(n: number): string {
  let result = "";
  let i = n;
  do {
    result = String.fromCharCode(65 + (i % 26)) + result;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return result;
}

export default function SpreadsheetEditor() {
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
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${sheetName}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
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

  if (openSheetId !== null) {
    return (
      <div className="-mx-3 sm:-mx-6 -mt-3 sm:-mt-6 flex flex-col" style={{ height: "calc(100vh - 56px)" }}>
        <div className="h-12 flex items-center gap-2 px-3 border-b bg-background shrink-0">
          <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-spreadsheet-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {editingName ? (
            <Input
              ref={nameInputRef}
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              onBlur={confirmRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRename();
                if (e.key === "Escape") setEditingName(false);
              }}
              className="h-8 max-w-xs text-sm font-medium"
              data-testid="input-spreadsheet-name"
            />
          ) : (
            <button
              className="flex items-center gap-1.5 group"
              onClick={startRename}
              data-testid="button-rename-spreadsheet"
            >
              <span className="text-sm font-medium">{sheetName}</span>
              <Pencil className="h-3 w-3 text-muted-foreground opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity" />
            </button>
          )}
          <div className="flex items-center gap-1 text-xs text-muted-foreground ml-1">
            {saveStatus === "saving" && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>Saving…</span>
              </>
            )}
            {saveStatus === "saved" && (
              <>
                <Check className="h-3 w-3 text-green-600" />
                <span>Saved</span>
              </>
            )}
            {saveStatus === "unsaved" && <span>Unsaved changes</span>}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={handleDownload} data-testid="button-download-xlsx">
              <Download className="h-4 w-4 mr-1.5" />
              Download .xlsx
            </Button>
          </div>
        </div>
        <div
          ref={containerRef}
          style={{ height: "calc(100vh - 104px)" }}
          className="overflow-visible"
          onMouseDown={markInteracted}
          onKeyDown={markInteracted}
          onTouchStart={markInteracted}
        >
          {sheetLoading || !openedSheet ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin mr-2" />
              Loading spreadsheet…
            </div>
          ) : (
            <Workbook
              ref={workbookRef}
              key={openSheetId}
              data={initialData}
              onChange={handleChange}
              showToolbar
              showFormulaBar
              showSheetTabs
              lang="en"
              toolbarItems={TOOLBAR_ITEMS}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div>
          <PageHeader title="Spreadsheets" subtitle="Shared workbooks — all users can view and edit" />
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={handleUpload}
            data-testid="input-upload-xlsx"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={createMutation.isPending}
            data-testid="button-upload-xlsx"
          >
            <Upload className="h-4 w-4 mr-1.5" />
            Upload .xlsx
          </Button>
          <Button
            size="sm"
            onClick={handleNew}
            disabled={createMutation.isPending}
            data-testid="button-new-spreadsheet"
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Plus className="h-4 w-4 mr-1.5" />
            )}
            New Spreadsheet
          </Button>
        </div>
      </div>

      {libraryLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading…
        </div>
      ) : library.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <FileSpreadsheet className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <p className="text-sm font-medium text-muted-foreground">No spreadsheets yet</p>
          <p className="text-xs text-muted-foreground mt-1 mb-4">
            Create a new spreadsheet or upload an existing .xlsx file
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4 mr-1.5" />
              Upload .xlsx
            </Button>
            <Button size="sm" onClick={handleNew}>
              <Plus className="h-4 w-4 mr-1.5" />
              New Spreadsheet
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {library.map((sheet) => (
            <Card
              key={sheet.id}
              className="hover-elevate cursor-pointer group"
              onClick={() => handleOpen(sheet.id, sheet.name)}
              data-testid={`card-spreadsheet-${sheet.id}`}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <FileSpreadsheet className="h-8 w-8 text-green-600 dark:text-green-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" data-testid={`text-sheet-name-${sheet.id}`}>
                        {sheet.name}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">{formatRelativeTime(sheet.updatedAt)}</p>
                      {sheet.createdBy && <p className="text-xs text-muted-foreground truncate">{sheet.createdBy}</p>}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity h-7 w-7"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(sheet.id);
                    }}
                    data-testid={`button-delete-sheet-${sheet.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete spreadsheet?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the spreadsheet and all its data. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget !== null && deleteMutation.mutate(deleteTarget)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
