import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {} from "@/components/ui/dialog";
import { LayoutGrid, Plus, Save, FileDown, Upload, Download, X, Link2, Link2Off } from "lucide-react";

import type {
  ApiSheet,
  CellValue,
  LinkDialogState,
  PendingDelete,
  StatusBuilderSheet,
} from "./factorystatusbuilder/types";
import {
  calcDiff,
  computeDiffValue,
  computeTotalValue,
  fmt,
  fromApiSheet,
  getEffectiveValue,
  isDiffColumn,
  isTotalColumn,
  makeId,
  parseCellValue,
  resolveCellValue,
} from "./factorystatusbuilder/utils";
import { TabLabel } from "./factorystatusbuilder/components/TabLabel";
import { LinkDialog } from "./factorystatusbuilder/components/LinkDialog";
import { StatusHistoryPanel } from "./factorystatusbuilder/components/StatusHistoryPanel";
import { DeleteConfirmationDialog } from "./factorystatusbuilder/components/DeleteConfirmationDialog";
import { StatusViewToggle } from "./factorystatusbuilder/components/StatusViewToggle";
// ── Types ─────────────────────────────────────────────────────────────────────

export default function FactoryStatusBuilder() {
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [localSheets, setLocalSheets] = useState<StatusBuilderSheet[]>([]);
  const [initialised, setInitialised] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silentSaveRef = useRef(false);

  const [linkDialog, setLinkDialog] = useState<LinkDialogState>({
    open: false,
    targetRowIdx: 0,
    targetColIdx: 0,
    sourceSheetId: "",
    sourceRowId: "",
    sourceColId: "",
  });

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const [viewMode, setViewMode] = useState<"sheet" | "history">("sheet");

  const fmtLabel = useCallback(
    (label: string): string => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return formatDisplayDate(label);
      return label;
    },
    [formatDisplayDate]
  );

  // ── Load ───────────────────────────────────────────────────────────────────
  const { data: apiSheets, isLoading } = useQuery<ApiSheet[]>({
    queryKey: ["/api/factory/status-builder/sheets"],
  });

  useEffect(() => {
    if (apiSheets && !initialised) {
      setLocalSheets(apiSheets.map(fromApiSheet));
      setInitialised(true);
    }
  }, [apiSheets, initialised]);

  const activeSheet = localSheets[activeIdx] ?? null;
  const isDirty = localSheets.some((s) => s.dirty);

  // ── History log ────────────────────────────────────────────────────────────
  const { data: historyLog, isLoading: historyLoading } = useQuery<
    Array<{
      id: number;
      sheetId: number;
      sheetName: string;
      rowLabel: string;
      columnLabel: string;
      oldValue: string | null;
      newValue: string | null;
      changedBy: string | null;
      createdAt: string;
    }>
  >({
    queryKey: ["/api/factory/status-builder/log", activeSheet?.id],
    queryFn: () =>
      apiRequest("GET", `/api/factory/status-builder/log?sheetId=${activeSheet?.id}&limit=200`).then((r) => r.json()),
    enabled: viewMode === "history" && !!activeSheet?.id,
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const updateSheet = useCallback(
    (fn: (s: StatusBuilderSheet) => StatusBuilderSheet) => {
      setLocalSheets((prev) => {
        const next = [...prev];
        next[activeIdx] = { ...fn(next[activeIdx]), dirty: true };
        return next;
      });
    },
    [activeIdx]
  );

  // ── Link operations ────────────────────────────────────────────────────────
  const openLinkDialog = useCallback(
    (rowIdx: number, colIdx: number) => {
      const cell = activeSheet?.rows[rowIdx]?.cells[colIdx] ?? { value: null };
      setLinkDialog({
        open: true,
        targetRowIdx: rowIdx,
        targetColIdx: colIdx,
        sourceSheetId: cell.link?.sourceSheetId ?? "",
        sourceRowId: cell.link?.sourceRowId ?? "",
        sourceColId: cell.link?.sourceColumnId ?? "",
      });
    },
    [activeSheet]
  );

  const handleSaveLink = useCallback(
    (sourceSheetId: string, sourceRowId: string, sourceColId: string) => {
      const { targetRowIdx, targetColIdx } = linkDialog;
      updateSheet((s) => {
        const rows = s.rows.map((r, ri) => {
          if (ri !== targetRowIdx) return r;
          const cells = [...r.cells];
          const existing = cells[targetColIdx] ?? { value: null };
          cells[targetColIdx] = {
            ...existing,
            link: { type: "status_builder_cell", sourceSheetId, sourceRowId, sourceColumnId: sourceColId },
          };
          return { ...r, cells };
        });
        return { ...s, rows };
      });
      setLinkDialog((prev) => ({ ...prev, open: false }));
    },
    [linkDialog, updateSheet]
  );

  const unlinkCell = useCallback(
    (rowIdx: number, colIdx: number) => {
      updateSheet((s) => {
        const rows = s.rows.map((r, ri) => {
          if (ri !== rowIdx) return r;
          const cells = [...r.cells];
          const existing = cells[colIdx] ?? { value: null };
          cells[colIdx] = { value: existing.value, link: null };
          return { ...r, cells };
        });
        return { ...s, rows };
      });
    },
    [updateSheet]
  );

  const copyLinkValueAsManual = useCallback(
    (rowIdx: number, colIdx: number) => {
      const sheet = localSheets[activeIdx];
      if (!sheet) return;
      const cell = sheet.rows[rowIdx]?.cells[colIdx];
      if (!cell?.link) return;
      const resolved = resolveCellValue(
        localSheets,
        cell.link.sourceSheetId,
        cell.link.sourceRowId,
        cell.link.sourceColumnId
      );
      updateSheet((s) => {
        const rows = s.rows.map((r, ri) => {
          if (ri !== rowIdx) return r;
          const cells = [...r.cells];
          cells[colIdx] = {
            value: resolved.broken || resolved.circular ? null : (resolved.value as CellValue),
            link: null,
          };
          return { ...r, cells };
        });
        return { ...s, rows };
      });
    },
    [localSheets, activeIdx, updateSheet]
  );

  // ── Mutations ──────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest("POST", "/api/factory/status-builder/sheets", { name }).then((r) => r.json()),
    onSuccess: (created: ApiSheet) => {
      setLocalSheets((prev) => [...prev, fromApiSheet(created)]);
      setActiveIdx((prev) => prev + 1);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/status-builder/sheets"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const saveMutation = useMutation({
    mutationFn: async (sheets: StatusBuilderSheet[]) => {
      const dirty = sheets.filter((s) => s.dirty && s.id !== null);
      await Promise.all(
        dirty.map((s) =>
          apiRequest("PUT", `/api/factory/status-builder/sheets/${s.id}`, {
            name: s.name,
            columns: s.columns,
            rows: s.rows.map((r) => ({
              id: r.id,
              label: r.label,
              cells: r.cells.map((c) => (c.link ? { value: c.value, link: c.link } : c.value)),
            })),
          })
        )
      );
    },
    onSuccess: () => {
      setLocalSheets((prev) => prev.map((s) => ({ ...s, dirty: false })));
      queryClient.invalidateQueries({ queryKey: ["/api/factory/status-builder/sheets"] });
      setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      if (!silentSaveRef.current) toast({ title: "Saved", description: "All pages saved." });
      silentSaveRef.current = false;
    },
    onError: (e: ClientErrorLike) => {
      silentSaveRef.current = false;
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    const hasSaveable = localSheets.some((s) => s.dirty && s.id !== null);
    if (!hasSaveable) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      silentSaveRef.current = true;
      saveMutation.mutate(localSheets);
    }, 2000);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [localSheets, saveMutation]);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/factory/status-builder/sheets/${id}`),
    onSuccess: (_data, id) => {
      setLocalSheets((prev) => prev.filter((s) => s.id !== id));
      setActiveIdx((prev) => Math.max(0, prev - 1));
      queryClient.invalidateQueries({ queryKey: ["/api/factory/status-builder/sheets"] });
      toast({ title: "Page deleted" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const importMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return fetch("/api/factory/status-builder/sheets/import", {
        method: "POST",
        credentials: "include",
        body: fd,
      }).then(async (r) => {
        if (!r.ok) {
          const t = await r.text();
          try {
            throw new Error(JSON.parse(t).message);
          } catch {
            throw new Error(t);
          }
        }
        return r.json() as Promise<ApiSheet[]>;
      });
    },
    onSuccess: (sheets: ApiSheet[]) => {
      setLocalSheets(sheets.map(fromApiSheet));
      setActiveIdx(0);
      setInitialised(true);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/status-builder/sheets"] });
      toast({ title: "Imported", description: `${sheets.length} page(s) imported.` });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Import failed", description: e.message, variant: "destructive" }),
  });

  const handleExport = () => window.open("/api/factory/status-builder/sheets/export", "_blank");

  // ── Tab operations ─────────────────────────────────────────────────────────
  const addTab = () => createMutation.mutate(`Page ${localSheets.length + 1}`);

  const renameTab = (idx: number, newName: string) => {
    setLocalSheets((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], name: newName, dirty: true };
      return next;
    });
  };

  const deleteTab = (idx: number) => {
    const s = localSheets[idx];
    if (!s) return;
    setPendingDelete({ type: "page", idx, label: s.name });
  };

  // ── Column operations ──────────────────────────────────────────────────────
  const addColumn = useCallback(() => {
    updateSheet((s) => ({
      ...s,
      columns: [...s.columns, { id: `col_${makeId()}`, label: `Col ${s.columns.length + 1}` }],
      rows: s.rows.map((r) => ({ ...r, cells: [...r.cells, { value: null }] })),
    }));
  }, [updateSheet]);

  const removeColumn = (colIdx: number) => {
    updateSheet((s) => ({
      ...s,
      columns: s.columns.filter((_, i) => i !== colIdx),
      rows: s.rows.map((r) => ({ ...r, cells: r.cells.filter((_, i) => i !== colIdx) })),
      lockedColumns: s.lockedColumns.filter((i) => i !== colIdx).map((i) => (i > colIdx ? i - 1 : i)),
    }));
  };

  const setColumnHeader = (colIdx: number, val: string) => {
    updateSheet((s) => {
      const columns = [...s.columns];
      columns[colIdx] = { ...columns[colIdx], label: val };
      return { ...s, columns };
    });
  };

  // ── Row operations ─────────────────────────────────────────────────────────
  const addRow = () => {
    updateSheet((s) => ({
      ...s,
      rows: [...s.rows, { id: `row_${makeId()}`, label: "", cells: Array(s.columns.length).fill({ value: null }) }],
    }));
  };

  const removeRow = (rowIdx: number) => {
    updateSheet((s) => ({ ...s, rows: s.rows.filter((_, i) => i !== rowIdx) }));
  };

  const setRowLabel = (rowIdx: number, val: string) => {
    updateSheet((s) => ({
      ...s,
      rows: s.rows.map((r, i) => (i === rowIdx ? { ...r, label: val } : r)),
    }));
  };

  const setCellDirect = (rowIdx: number, colIdx: number, val: string) => {
    updateSheet((s) => ({
      ...s,
      rows: s.rows.map((r, i) => {
        if (i !== rowIdx) return r;
        const cells = [...r.cells];
        cells[colIdx] = { value: parseCellValue(val), link: null };
        return { ...r, cells };
      }),
    }));
  };

  // ── Keyboard navigation ────────────────────────────────────────────────────
  const focusCell = useCallback((ri: number, ci: number) => {
    const el = document.querySelector(`[data-testid="sb-input-cell-${ri}-${ci}"]`) as HTMLInputElement | null;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, ri: number, ci: number) => {
      const sheet = localSheets[activeIdx];
      if (!sheet) return;
      const rowCount = sheet.rows.length;
      const colCount = sheet.columns.length;

      if (e.key === "Enter") {
        e.preventDefault();
        if (ri >= rowCount - 1) {
          updateSheet((s) => ({
            ...s,
            rows: [
              ...s.rows,
              { id: `row_${makeId()}`, label: "", cells: Array(s.columns.length).fill({ value: null }) },
            ],
          }));
          setTimeout(() => focusCell(rowCount, ci), 30);
        } else focusCell(ri + 1, ci);
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          if (ci > 0) focusCell(ri, ci - 1);
          else if (ri > 0) focusCell(ri - 1, colCount - 1);
        } else {
          if (ci < colCount - 1) focusCell(ri, ci + 1);
          else if (ri < rowCount - 1) focusCell(ri + 1, 0);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (ri > 0) focusCell(ri - 1, ci);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (ri < rowCount - 1) focusCell(ri + 1, ci);
      } else if (e.key === "ArrowLeft") {
        const input = e.currentTarget;
        if (input.selectionStart === 0 && input.selectionEnd === 0 && ci > 0) {
          e.preventDefault();
          focusCell(ri, ci - 1);
        }
      } else if (e.key === "ArrowRight") {
        const input = e.currentTarget;
        if (input.selectionStart === input.value.length && ci < colCount - 1) {
          e.preventDefault();
          focusCell(ri, ci + 1);
        }
      }
    },
    [localSheets, activeIdx, focusCell, updateSheet]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "i") {
        e.preventDefault();
        addColumn();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIdx, addColumn, localSheets]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (isLoading) {
    return <div className="flex items-center justify-center min-h-[200px] text-muted-foreground">Loading pages…</div>;
  }

  const diffRow = activeSheet ? calcDiff(localSheets, activeSheet) : [];

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0 bg-background">
        {/* Link dialog */}
        <LinkDialog
          state={linkDialog}
          sheets={localSheets}
          onClose={() => setLinkDialog((prev) => ({ ...prev, open: false }))}
          onSave={handleSaveLink}
        />

        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b flex-wrap">
          <LayoutGrid className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-semibold text-foreground mr-2">Factory Sheets</span>
          <div className="flex-1" />
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importMutation.mutate(f);
              e.target.value = "";
            }}
            data-testid="sb-input-import-file"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open("/api/factory/status-builder/sheets/template", "_blank")}
            data-testid="sb-button-download-template"
          >
            <FileDown className="h-3.5 w-3.5 mr-1.5" />
            Template
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importMutation.isPending}
            data-testid="sb-button-import-excel"
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Import Excel
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExport}
            disabled={localSheets.length === 0}
            data-testid="sb-button-export-excel"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export Excel
          </Button>
          {savedAt && !isDirty && (
            <span className="text-xs text-muted-foreground" data-testid="sb-text-autosaved">
              Autosaved {savedAt}
            </span>
          )}
          <Button
            size="sm"
            onClick={() => {
              silentSaveRef.current = false;
              saveMutation.mutate(localSheets);
            }}
            disabled={!isDirty || saveMutation.isPending}
            data-testid="sb-button-save"
          >
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>

        <StatusViewToggle viewMode={viewMode} onChange={setViewMode} />

        {/* Tabs */}
        <div className="flex items-end gap-0 px-4 border-b overflow-x-auto">
          {localSheets.map((s, idx) => (
            <TabLabel
              key={s.id ?? `new-${idx}`}
              name={s.name}
              active={idx === activeIdx}
              onActivate={() => setActiveIdx(idx)}
              onRename={(v) => renameTab(idx, v)}
              onDelete={() => deleteTab(idx)}
              canDelete={localSheets.length > 1}
            />
          ))}
          <button
            data-testid="sb-button-add-tab"
            onClick={addTab}
            className="flex items-center gap-1 px-3 py-2 text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add page
          </button>
        </div>

        {/* Content */}
        {!activeSheet ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            <div className="text-center space-y-2">
              <LayoutGrid className="h-10 w-10 mx-auto opacity-30" />
              <p>No pages yet. Import an Excel file or add a page.</p>
            </div>
          </div>
        ) : viewMode === "history" ? (
          <StatusHistoryPanel historyLoading={historyLoading} historyLog={historyLog} />
        ) : (
          /* ── Spreadsheet grid ── */
          <div className="flex-1 overflow-auto p-4">
            <div className="w-fit">
              <table className="border-collapse text-sm" data-testid="sb-grid-table">
                <thead className="sticky top-0 z-30">
                  <tr>
                    <th className="border border-border bg-muted px-2 py-1.5 text-left font-medium text-muted-foreground min-w-[180px]">
                      Label
                    </th>
                    {activeSheet.columns.map((col, ci) => (
                      <th
                        key={col.id}
                        className="border border-border bg-muted px-1 py-1 text-center font-medium min-w-[130px]"
                      >
                        <div className="flex items-center gap-1">
                          <Input
                            value={col.label}
                            onChange={(e) => setColumnHeader(ci, e.target.value)}
                            className="h-7 text-xs text-center font-semibold border-0 bg-transparent focus-visible:ring-1 focus-visible:ring-primary px-1"
                            data-testid={`sb-input-col-header-${ci}`}
                          />
                          <button
                            data-testid={`sb-button-remove-col-${ci}`}
                            onClick={() =>
                              setPendingDelete({ type: "col", idx: ci, label: col.label || `Column ${ci + 1}` })
                            }
                            className="text-muted-foreground hover:text-destructive shrink-0 transition-colors"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </th>
                    ))}
                    <th className="border border-border bg-muted px-2 py-1.5 text-center">
                      <button
                        data-testid="sb-button-add-column"
                        onClick={addColumn}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        title="Add column"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {activeSheet.rows.map((row, ri) => (
                    <tr key={row.id} className="group hover:bg-muted/30">
                      {/* Row label */}
                      <td className="border border-border px-1 py-0.5 bg-muted/20">
                        <div className="flex items-center gap-1">
                          <Input
                            value={fmtLabel(row.label)}
                            onChange={(e) => setRowLabel(ri, e.target.value)}
                            className="h-7 text-xs border-0 bg-transparent focus-visible:ring-1 focus-visible:ring-primary px-1 flex-1"
                            data-testid={`sb-input-row-label-${ri}`}
                            dir="auto"
                          />
                          <button
                            data-testid={`sb-button-remove-row-${ri}`}
                            onClick={() =>
                              setPendingDelete({ type: "row", idx: ri, label: fmtLabel(row.label) || `Row ${ri + 1}` })
                            }
                            className="text-muted-foreground hover:text-destructive shrink-0 transition-colors opacity-0 group-hover:opacity-100"
                            style={{ visibility: "visible" }}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </td>

                      {/* Data cells */}
                      {activeSheet.columns.map((col, ci) => {
                        const isDiff = isDiffColumn(col.label);
                        const isTotal = isTotalColumn(col.label);
                        const cell = row.cells[ci] ?? { value: null };
                        const isLinked = !!cell.link;

                        let displayValue: CellValue | "#REF!" | "#CYCLE!";
                        let isBroken = false;
                        let isCyclic = false;

                        if (isDiff || isTotal) {
                          const colLabels = activeSheet.columns.map((c) => c.label);
                          const rowResolvedVals: (number | null)[] = activeSheet.columns.map((_, idx) => {
                            const c = row.cells[idx] ?? { value: null };
                            const eff = getEffectiveValue(localSheets, c);
                            return typeof eff === "number" ? eff : null;
                          });
                          displayValue = isDiff
                            ? computeDiffValue(colLabels, rowResolvedVals, ci)
                            : computeTotalValue(colLabels, rowResolvedVals);
                        } else if (isLinked) {
                          const res = resolveCellValue(
                            localSheets,
                            cell.link!.sourceSheetId,
                            cell.link!.sourceRowId,
                            cell.link!.sourceColumnId
                          );
                          displayValue = res.value;
                          isBroken = res.broken;
                          isCyclic = res.circular;
                        } else {
                          displayValue = cell.value;
                        }

                        const isNeg = typeof displayValue === "number" && displayValue < 0;
                        const isErrorVal = displayValue === "#REF!" || displayValue === "#CYCLE!";
                        const isTextVal = !isDiff && !isLinked && typeof cell.value === "string" && cell.value !== "-";

                        let linkInfo: string | null = null;
                        if (isLinked && !isBroken && !isCyclic) {
                          const srcSheet = localSheets.find((s) => s.stableId === cell.link!.sourceSheetId);
                          const srcRow = srcSheet?.rows.find((r) => r.id === cell.link!.sourceRowId);
                          const srcCol = srcSheet?.columns.find((c) => c.id === cell.link!.sourceColumnId);
                          if (srcSheet && srcRow && srcCol) {
                            linkInfo = `${srcSheet.name} → ${srcRow.label || "(row)"} → ${srcCol.label || "(col)"}`;
                          }
                        }

                        const srcSheetIdxForJump = isLinked
                          ? localSheets.findIndex((s) => s.stableId === cell.link!.sourceSheetId)
                          : -1;

                        return (
                          <td
                            key={col.id}
                            className={`border border-border px-0 py-0 ${isDiff ? "bg-muted/20" : isTotal ? "bg-blue-50/60 dark:bg-blue-950/30" : ""}`}
                          >
                            <div className="relative group/cell">
                              {isDiff || isTotal || isLinked ? (
                                <div
                                  data-testid={
                                    isLinked
                                      ? `sb-linked-cell-${ri}-${ci}`
                                      : isDiff
                                        ? `sb-diff-cell-${ri}-${ci}`
                                        : `sb-total-cell-${ri}-${ci}`
                                  }
                                  className={`h-7 px-2 flex items-center gap-1 text-xs tabular-nums select-none cursor-default
                                    ${isErrorVal ? "text-red-500 font-mono" : isNeg ? "text-red-500" : isDiff ? "text-foreground font-medium" : isTotal ? "text-blue-700 dark:text-blue-300 font-semibold" : "text-foreground"}
                                    ${isTextVal ? "justify-start" : "justify-center"}`}
                                  title={
                                    isDiff
                                      ? "Auto-calculated: DIFF"
                                      : isTotal
                                        ? "Auto-calculated: sum of all columns"
                                        : isLinked && linkInfo
                                          ? `Linked from: ${linkInfo}`
                                          : ""
                                  }
                                >
                                  {isLinked && !isBroken && !isCyclic && (
                                    <Link2 className="h-2.5 w-2.5 text-blue-400 shrink-0" />
                                  )}
                                  {(isBroken || isCyclic) && <Link2Off className="h-2.5 w-2.5 text-red-400 shrink-0" />}
                                  <span className="tabular-nums">{fmt(displayValue)}</span>
                                </div>
                              ) : (
                                <Input
                                  value={fmt(cell.value)}
                                  onChange={(e) => setCellDirect(ri, ci, e.target.value)}
                                  onKeyDown={(e) => handleCellKeyDown(e, ri, ci)}
                                  className={`h-7 text-xs border-0 bg-transparent focus-visible:ring-1 focus-visible:ring-primary px-2 tabular-nums
                                    ${isNeg ? "text-red-500" : ""}
                                    ${isTextVal ? "text-left" : "text-center"}`}
                                  data-testid={`sb-input-cell-${ri}-${ci}`}
                                  dir="auto"
                                />
                              )}

                              {/* Link menu */}
                              {!isDiff && !isTotal && (
                                <div
                                  className={`absolute top-0.5 right-0.5 z-10 transition-opacity ${isLinked ? "opacity-100" : "opacity-0 group-hover/cell:opacity-100"}`}
                                >
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <button
                                        className="p-0.5 rounded-sm hover:bg-muted/60"
                                        onClick={(e) => e.stopPropagation()}
                                        data-testid={`sb-button-cell-menu-${ri}-${ci}`}
                                        title={isLinked ? `Linked from: ${linkInfo ?? "…"}` : "Link this cell"}
                                      >
                                        {isBroken || isCyclic ? (
                                          <Link2Off className="h-2.5 w-2.5 text-red-400" />
                                        ) : isLinked ? (
                                          <Link2 className="h-2.5 w-2.5 text-blue-400" />
                                        ) : (
                                          <Link2 className="h-2.5 w-2.5 text-muted-foreground" />
                                        )}
                                      </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="text-xs min-w-[160px]">
                                      {isLinked && linkInfo && (
                                        <>
                                          <div className="px-2 py-1.5 text-xs text-muted-foreground max-w-[200px] leading-tight">
                                            {linkInfo}
                                          </div>
                                          <DropdownMenuSeparator />
                                        </>
                                      )}
                                      {!isLinked ? (
                                        <DropdownMenuItem
                                          onClick={() => openLinkDialog(ri, ci)}
                                          className="text-xs gap-2"
                                        >
                                          <Link2 className="h-3 w-3" />
                                          Link cell
                                        </DropdownMenuItem>
                                      ) : (
                                        <>
                                          <DropdownMenuItem
                                            onClick={() => openLinkDialog(ri, ci)}
                                            className="text-xs gap-2"
                                          >
                                            <Link2 className="h-3 w-3" />
                                            Change link
                                          </DropdownMenuItem>
                                          <DropdownMenuItem
                                            onClick={() => unlinkCell(ri, ci)}
                                            className="text-xs gap-2"
                                          >
                                            <Link2Off className="h-3 w-3" />
                                            Remove link
                                          </DropdownMenuItem>
                                          <DropdownMenuItem
                                            onClick={() => copyLinkValueAsManual(ri, ci)}
                                            className="text-xs gap-2"
                                          >
                                            Copy value as manual
                                          </DropdownMenuItem>
                                          {srcSheetIdxForJump !== -1 && (
                                            <DropdownMenuItem
                                              onClick={() => setActiveIdx(srcSheetIdxForJump)}
                                              className="text-xs gap-2"
                                            >
                                              Jump to source page
                                            </DropdownMenuItem>
                                          )}
                                        </>
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              )}
                            </div>
                          </td>
                        );
                      })}
                      {/* Add column placeholder */}
                      <td className="border border-border" />
                    </tr>
                  ))}

                  {/* Add row */}
                  <tr>
                    <td className="border border-border px-1 py-0.5 bg-muted/10">
                      <button
                        data-testid="sb-button-add-row"
                        onClick={addRow}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full px-1"
                      >
                        <Plus className="h-3 w-3" />
                        Add row
                      </button>
                    </td>
                    {activeSheet.columns.map((_, ci) => (
                      <td key={ci} className="border border-border" />
                    ))}
                    <td className="border border-border" />
                  </tr>

                  {/* Footer — DIFFERENCE row */}
                  {activeSheet.rows.length > 0 && (
                    <tr className="bg-amber-50/60 dark:bg-amber-950/20">
                      <td className="border border-border px-2 py-1.5">
                        <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">DIFFERENCE</span>
                      </td>
                      {diffRow.map((val, ci) => {
                        const isNeg = typeof val === "number" && val < 0;
                        return (
                          <td
                            key={ci}
                            className="border border-border px-2 py-1.5 text-xs font-semibold text-center tabular-nums"
                            data-testid={`sb-footer-diff-${ci}`}
                          >
                            <span className={isNeg ? "text-red-500" : "text-amber-700 dark:text-amber-400"}>
                              {fmt(val)}
                            </span>
                          </td>
                        );
                      })}
                      <td className="border border-border" />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <DeleteConfirmationDialog
        pendingDelete={pendingDelete}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPendingDelete(null);
        }}
        onConfirm={(pending) => {
          if (pending.type === "row") removeRow(pending.idx);
          else if (pending.type === "col") removeColumn(pending.idx);
          else {
            const sheet = localSheets[pending.idx];
            if (sheet) {
              if (sheet.id) deleteMutation.mutate(sheet.id);
              else {
                setLocalSheets((prev) => prev.filter((_, i) => i !== pending.idx));
                setActiveIdx((prev) => Math.max(0, prev - 1));
              }
            }
          }
          setPendingDelete(null);
        }}
      />
    </>
  );
}
