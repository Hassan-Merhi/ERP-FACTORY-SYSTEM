// Extracted from ./FactoryStatusBuilder.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type {
  ApiSheet,
  CellValue,
  LinkDialogState,
  PendingDelete,
  StatusBuilderSheet,
} from "./factorystatusbuilder/types";
import { fromApiSheet, resolveCellValue } from "./factorystatusbuilder/utils";

export function useFactoryStatusBuilderStatePart1() {
  const { selectedCompany } = useCompany();
  // Sheets are shared company records: read-only roles can browse, switch pages, view history and export.
  const recordChanges = useExistingRecordChangeAccess();
  const canEdit = recordChanges.allowed;
  const canCreateSheet = recordChanges.canCreate("POST", "/api/factory/status-builder/sheets");
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [localSheets, setLocalSheets] = useState<StatusBuilderSheet[]>([]);
  const [initialised, setInitialised] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silentSaveRef = useRef(false);
  const priorCompanyRef = useRef(selectedCompany?.id);
  useEffect(() => {
    if (priorCompanyRef.current === selectedCompany?.id) return;
    priorCompanyRef.current = selectedCompany?.id;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
    silentSaveRef.current = false;
    setLocalSheets([]);
    setInitialised(false);
    setActiveIdx(0);
    setSavedAt(null);
  }, [selectedCompany?.id]);

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

  // Display-only preferences: hiding a column never removes cells, changes formulas,
  // or alters the saved sheet. Preferences are local to this browser and sheet.
  const [hiddenColumnsBySheet, setHiddenColumnsBySheet] = useState<Record<string, string[]>>(() => {
    try {
      const stored = window.localStorage.getItem("factory-status-builder:hidden-columns:v1");
      const parsed: unknown = stored ? JSON.parse(stored) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string[]] =>
            Array.isArray(entry[1]) && entry[1].every((id: unknown) => typeof id === "string")
        )
      );
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem("factory-status-builder:hidden-columns:v1", JSON.stringify(hiddenColumnsBySheet));
    } catch {
      // Browser storage may be disabled; column visibility still works for this session.
    }
  }, [hiddenColumnsBySheet]);

  const setColumnHidden = (sheetId: string, columnId: string, hidden: boolean) => {
    setHiddenColumnsBySheet((prev) => {
      const ids = prev[sheetId] ?? [];
      return {
        ...prev,
        [sheetId]: hidden ? Array.from(new Set([...ids, columnId])) : ids.filter((id) => id !== columnId),
      };
    });
  };

  const fmtLabel = useCallback(
    (label: string): string => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return formatDisplayDate(label);
      return label;
    },
    [formatDisplayDate]
  );

  // ── Load ───────────────────────────────────────────────────────────────────
  const {
    data: apiSheets,
    isLoading,
    isError,
    refetch,
  } = useQuery<ApiSheet[]>({
    queryKey: companyQueryKey("/api/factory/status-builder/sheets", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  useEffect(() => {
    if (apiSheets && !initialised) {
      setLocalSheets(apiSheets.map(fromApiSheet));
      setInitialised(true);
    }
  }, [apiSheets, initialised]);

  const activeSheet = localSheets[activeIdx] ?? null;
  const hiddenColIds = activeSheet ? (hiddenColumnsBySheet[activeSheet.stableId] ?? []) : [];
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
    queryKey: companyQueryKey("/api/factory/status-builder/log", selectedCompany?.id, activeSheet?.id),
    queryFn: () =>
      apiRequest("GET", `/api/factory/status-builder/log?sheetId=${activeSheet?.id}&limit=200`).then((r) => r.json()),
    enabled: Boolean(selectedCompany?.id) && viewMode === "history" && !!activeSheet?.id,
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
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  return {
    apiSheets,
    refetch,
    isError,
    activeIdx,
    activeSheet,
    autosaveTimerRef,
    canCreateSheet,
    canEdit,
    copyLinkValueAsManual,
    createMutation,
    fileInputRef,
    fmtLabel,
    handleSaveLink,
    hiddenColIds,
    hiddenColumnsBySheet,
    historyLoading,
    historyLog,
    isDirty,
    isLoading,
    linkDialog,
    localSheets,
    openLinkDialog,
    pendingDelete,
    recordChanges,
    savedAt,
    setActiveIdx,
    setColumnHidden,
    setHiddenColumnsBySheet,
    setInitialised,
    setLinkDialog,
    setLocalSheets,
    setPendingDelete,
    setSavedAt,
    setViewMode,
    silentSaveRef,
    toast,
    unlinkCell,
    updateSheet,
    viewMode,
  };
}
