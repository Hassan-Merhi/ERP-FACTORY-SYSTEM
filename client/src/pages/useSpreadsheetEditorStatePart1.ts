// Extracted from ./SpreadsheetEditor.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Sheet as FortuneSheet } from "@fortune-sheet/core";
import type { WorkbookInstance } from "@fortune-sheet/react";
import type { SpreadsheetListItem } from "./spreadsheetEditorModel";
import { isExcelMode, type SpreadsheetData } from "@/lib/excelSync";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export function useSpreadsheetEditorStatePart1() {
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
  const {
    data: library = [],
    isLoading: libraryLoading,
    isError: libraryError,
    refetch: refetchLibrary,
  } = useQuery<SpreadsheetListItem[]>({
    queryKey: ["/api/spreadsheets"],
  });
  const {
    data: openedSheet,
    isLoading: sheetLoading,
    isError: sheetError,
    refetch: refetchSheet,
  } = useQuery({
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
  return {
    sheetError,
    refetchSheet,
    refetchLibrary,
    libraryError,
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
  };
}
