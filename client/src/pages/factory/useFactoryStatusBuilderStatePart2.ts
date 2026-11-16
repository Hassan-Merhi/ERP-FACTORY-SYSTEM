// Extracted from ./FactoryStatusBuilder.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import type { ApiSheet, StatusBuilderSheet } from "./factorystatusbuilder/types";
import { fromApiSheet, makeId, parseCellValue } from "./factorystatusbuilder/utils";
import { useFactoryStatusBuilderStatePart1 } from "./useFactoryStatusBuilderStatePart1";

export function useFactoryStatusBuilderStatePart2({
  autosaveTimerRef,
  canCreateSheet,
  canEdit,
  createMutation,
  localSheets,
  recordChanges,
  setActiveIdx,
  setInitialised,
  setLocalSheets,
  setPendingDelete,
  setSavedAt,
  silentSaveRef,
  toast,
  updateSheet,
}: Pick<
  Awaited<ReturnType<typeof useFactoryStatusBuilderStatePart1>>,
  | "autosaveTimerRef"
  | "canCreateSheet"
  | "canEdit"
  | "createMutation"
  | "localSheets"
  | "recordChanges"
  | "setActiveIdx"
  | "setInitialised"
  | "setLocalSheets"
  | "setPendingDelete"
  | "setSavedAt"
  | "silentSaveRef"
  | "toast"
  | "updateSheet"
>) {
  const saveMutation = useMutation({
    mutationFn: async (sheets: StatusBuilderSheet[]) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
    if (!hasSaveable || !canEdit) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      silentSaveRef.current = true;
      saveMutation.mutate(localSheets);
    }, 2000);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [localSheets, saveMutation, canEdit, autosaveTimerRef, silentSaveRef]);

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("DELETE", `/api/factory/status-builder/sheets/${id}`);
    },
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
      if (!recordChanges.allowed) return Promise.reject(new Error(recordChanges.reason ?? ""));
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

  const handleExport = async () => {
    try {
      await downloadFromUrl("/api/factory/status-builder/sheets/export", {
        fileName: exportFileName("factory sheets", "xlsx"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  // ── Tab operations ─────────────────────────────────────────────────────────
  const addTab = () => canCreateSheet && createMutation.mutate(`Page ${localSheets.length + 1}`);

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
  return {
    addColumn,
    addRow,
    addTab,
    deleteMutation,
    deleteTab,
    focusCell,
    handleExport,
    importMutation,
    removeColumn,
    removeRow,
    renameTab,
    saveMutation,
    setCellDirect,
    setColumnHeader,
    setRowLabel,
  };
}
