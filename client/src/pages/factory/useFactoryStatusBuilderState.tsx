// Extracted from ./FactoryStatusBuilder.tsx to keep that module under the source-size cap.
import { TabsList } from "@/components/ui/tabs";
import { useCallback, useEffect } from "react";
import { Plus } from "lucide-react";
import { makeId } from "./factorystatusbuilder/utils";
import { TabLabel } from "./factorystatusbuilder/components/TabLabel";
import { StatusColumnsMenu } from "./factorystatusbuilder/components/StatusColumnsMenu";
import { useFactoryStatusBuilderStatePart1 } from "./useFactoryStatusBuilderStatePart1";
import { useFactoryStatusBuilderStatePart2 } from "./useFactoryStatusBuilderStatePart2";

export function useFactoryStatusBuilderState() {
  const {
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
  } = useFactoryStatusBuilderStatePart1();
  const {
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
  } = useFactoryStatusBuilderStatePart2({
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
  });
  const { handleCellKeyDown } = useFactoryStatusBuilderStatePart3({
    activeIdx,
    addColumn,
    canEdit,
    focusCell,
    hiddenColumnsBySheet,
    localSheets,
    updateSheet,
  });
  return {
    activeIdx,
    activeSheet,
    addColumn,
    addRow,
    addTab,
    canCreateSheet,
    canEdit,
    copyLinkValueAsManual,
    deleteMutation,
    deleteTab,
    fileInputRef,
    fmtLabel,
    handleCellKeyDown,
    handleExport,
    handleSaveLink,
    hiddenColIds,
    historyLoading,
    historyLog,
    importMutation,
    isDirty,
    isLoading,
    linkDialog,
    localSheets,
    openLinkDialog,
    pendingDelete,
    removeColumn,
    removeRow,
    renameTab,
    saveMutation,
    savedAt,
    setActiveIdx,
    setCellDirect,
    setColumnHeader,
    setColumnHidden,
    setHiddenColumnsBySheet,
    setLinkDialog,
    setLocalSheets,
    setPendingDelete,
    setRowLabel,
    setViewMode,
    silentSaveRef,
    unlinkCell,
    viewMode,
  };
}

function useFactoryStatusBuilderStatePart3({
  activeIdx,
  addColumn,
  canEdit,
  focusCell,
  hiddenColumnsBySheet,
  localSheets,
  updateSheet,
}: Pick<
  Awaited<ReturnType<typeof useFactoryStatusBuilderStatePart1>> &
    Awaited<ReturnType<typeof useFactoryStatusBuilderStatePart2>>,
  "activeIdx" | "addColumn" | "canEdit" | "focusCell" | "hiddenColumnsBySheet" | "localSheets" | "updateSheet"
>) {
  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, ri: number, ci: number) => {
      const sheet = localSheets[activeIdx];
      if (!sheet) return;
      const rowCount = sheet.rows.length;
      const hiddenIds = hiddenColumnsBySheet[sheet.stableId] ?? [];
      const visibleCols = sheet.columns
        .map((col, index) => (hiddenIds.includes(col.id) ? -1 : index))
        .filter((index) => index !== -1);
      const visiblePosition = visibleCols.indexOf(ci);
      const previousCol = visiblePosition > 0 ? visibleCols[visiblePosition - 1] : null;
      const nextCol =
        visiblePosition >= 0 && visiblePosition < visibleCols.length - 1 ? visibleCols[visiblePosition + 1] : null;

      if (e.key === "Enter") {
        e.preventDefault();
        if (ri >= rowCount - 1) {
          if (!canEdit) return;
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
          if (previousCol !== null) focusCell(ri, previousCol);
          else if (ri > 0 && visibleCols.length > 0) focusCell(ri - 1, visibleCols[visibleCols.length - 1]);
        } else {
          if (nextCol !== null) focusCell(ri, nextCol);
          else if (ri < rowCount - 1 && visibleCols.length > 0) focusCell(ri + 1, visibleCols[0]);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (ri > 0) focusCell(ri - 1, ci);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (ri < rowCount - 1) focusCell(ri + 1, ci);
      } else if (e.key === "ArrowLeft") {
        const input = e.currentTarget;
        if (input.selectionStart === 0 && input.selectionEnd === 0 && previousCol !== null) {
          e.preventDefault();
          focusCell(ri, previousCol);
        }
      } else if (e.key === "ArrowRight") {
        const input = e.currentTarget;
        if (input.selectionStart === input.value.length && nextCol !== null) {
          e.preventDefault();
          focusCell(ri, nextCol);
        }
      }
    },
    [localSheets, activeIdx, focusCell, updateSheet, hiddenColumnsBySheet, canEdit]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (canEdit && (e.ctrlKey || e.metaKey) && e.key === "i") {
        e.preventDefault();
        addColumn();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIdx, addColumn, localSheets, canEdit]);
  return { handleCellKeyDown };
}

export function FactoryStatusBuilderSection({
  activeIdx,
  activeSheet,
  addTab,
  canCreateSheet,
  canEdit,
  deleteTab,
  hiddenColIds,
  localSheets,
  renameTab,
  setActiveIdx,
  setColumnHidden,
  setHiddenColumnsBySheet,
  viewMode,
}: Pick<
  ReturnType<typeof useFactoryStatusBuilderState>,
  | "activeIdx"
  | "activeSheet"
  | "addTab"
  | "canCreateSheet"
  | "canEdit"
  | "deleteTab"
  | "hiddenColIds"
  | "localSheets"
  | "renameTab"
  | "setActiveIdx"
  | "setColumnHidden"
  | "setHiddenColumnsBySheet"
  | "viewMode"
>) {
  return (
    <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2">
      <div className="erp-mobile-scroll-tabs min-w-0 flex-1">
        <div className="flex w-max items-center gap-1">
          <TabsList className="w-max" aria-label="Status sheet pages">
            {localSheets.map((s, idx) => (
              <TabLabel
                key={s.id ?? `new-${idx}`}
                name={s.name}
                active={idx === activeIdx}
                onActivate={() => setActiveIdx(idx)}
                onRename={(v) => renameTab(idx, v)}
                onDelete={() => deleteTab(idx)}
                canDelete={canEdit && localSheets.length > 1}
                canRename={canEdit}
              />
            ))}
          </TabsList>
          {canCreateSheet && (
            <button
              type="button"
              data-testid="sb-button-add-tab"
              onClick={addTab}
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
            >
              <Plus className="h-3.5 w-3.5" />
              Add page
            </button>
          )}
        </div>
      </div>
      {activeSheet && viewMode === "sheet" && (
        <StatusColumnsMenu
          columns={activeSheet.columns}
          hiddenColumnIds={hiddenColIds}
          onSetHidden={(columnId, hidden) => setColumnHidden(activeSheet.stableId, columnId, hidden)}
          onShowAll={() => setHiddenColumnsBySheet((prev) => ({ ...prev, [activeSheet.stableId]: [] }))}
        />
      )}
    </div>
  );
}
