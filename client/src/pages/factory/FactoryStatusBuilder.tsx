import { Input } from "@/components/ui/input";
import {} from "@/components/ui/dialog";
import { LayoutGrid, Plus, X, Link2, Link2Off } from "lucide-react";

import type { CellValue } from "./factorystatusbuilder/types";
import {
  calcDiff,
  computeDiffValue,
  computeTotalValue,
  fmt,
  getEffectiveValue,
  isDiffColumn,
  isTotalColumn,
  resolveCellValue,
} from "./factorystatusbuilder/utils";
import { LinkDialog } from "./factorystatusbuilder/components/LinkDialog";
import { StatusHistoryPanel } from "./factorystatusbuilder/components/StatusHistoryPanel";
import { DeleteConfirmationDialog } from "./factorystatusbuilder/components/DeleteConfirmationDialog";
import { StatusViewToggle } from "./factorystatusbuilder/components/StatusViewToggle";
import { StatusBuilderToolbar } from "./factorystatusbuilder/components/StatusBuilderToolbar";
import { StatusAddRow } from "./factorystatusbuilder/components/StatusAddRow";
import { StatusCellLinkMenu } from "./factorystatusbuilder/components/StatusCellLinkMenu";
import { StatusDiffFooterRow } from "./factorystatusbuilder/components/StatusDiffFooterRow";
import { FactoryStatusBuilderSection, useFactoryStatusBuilderState } from "./useFactoryStatusBuilderState";

// ── Types ─────────────────────────────────────────────────────────────────────

export default function FactoryStatusBuilder() {
  const {
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
  } = useFactoryStatusBuilderState();

  // ── Render ─────────────────────────────────────────────────────────────────
  if (isLoading) {
    return <div className="flex items-center justify-center min-h-[200px] text-muted-foreground">Loading pages…</div>;
  }

  const diffRow = activeSheet ? calcDiff(localSheets, activeSheet) : [];

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm dark:shadow-black/20">
        {/* Link dialog */}
        <LinkDialog
          state={linkDialog}
          sheets={localSheets}
          onClose={() => setLinkDialog((prev) => ({ ...prev, open: false }))}
          onSave={handleSaveLink}
        />

        {/* Toolbar */}
        <StatusBuilderToolbar
          fileInputRef={fileInputRef}
          onImportFile={(file) => importMutation.mutate(file)}
          importPending={importMutation.isPending}
          onExport={handleExport}
          exportDisabled={localSheets.length === 0}
          savedAt={savedAt}
          isDirty={isDirty}
          savePending={saveMutation.isPending}
          onSave={() => {
            silentSaveRef.current = false;
            saveMutation.mutate(localSheets);
          }}
          canEdit={canEdit}
        />

        <StatusViewToggle viewMode={viewMode} onChange={setViewMode} />

        <FactoryStatusBuilderSection
          activeIdx={activeIdx}
          activeSheet={activeSheet}
          addTab={addTab}
          canCreateSheet={canCreateSheet}
          canEdit={canEdit}
          deleteTab={deleteTab}
          hiddenColIds={hiddenColIds}
          localSheets={localSheets}
          renameTab={renameTab}
          setActiveIdx={setActiveIdx}
          setColumnHidden={setColumnHidden}
          setHiddenColumnsBySheet={setHiddenColumnsBySheet}
          viewMode={viewMode}
        />

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
          <div className="flex-1 min-h-0 overflow-auto px-4 pb-5 pt-4">
            <div className="w-fit min-w-full overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm">
              <table className="w-full border-separate border-spacing-0 text-sm" data-testid="sb-grid-table">
                <thead className="sticky top-0 z-30">
                  <tr>
                    <th className="min-w-[230px] border-b border-r border-border/60 bg-slate-100 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground dark:bg-slate-800/90">
                      Label
                    </th>
                    {activeSheet.columns.map((col, ci) => (
                      <th
                        key={col.id}
                        className={`min-w-[180px] border-b border-r border-border/60 bg-slate-100 px-2 py-2 text-center font-medium dark:bg-slate-800/90 ${hiddenColIds.includes(col.id) ? "hidden" : ""}`}
                      >
                        <div className="flex items-center gap-1">
                          <Input
                            value={col.label}
                            onChange={(e) => setColumnHeader(ci, e.target.value)}
                            readOnly={!canEdit}
                            className="h-8 border-0 bg-transparent px-1 text-center text-xs font-bold tracking-wide text-foreground shadow-none focus-visible:ring-1 focus-visible:ring-primary"
                            data-testid={`sb-input-col-header-${ci}`}
                          />
                          {canEdit && (
                            <button
                              data-testid={`sb-button-remove-col-${ci}`}
                              onClick={() =>
                                setPendingDelete({ type: "col", idx: ci, label: col.label || `Column ${ci + 1}` })
                              }
                              className="shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                              title="Delete column (removes data); use Columns to hide instead"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </th>
                    ))}
                    <th className="border-b border-border/60 bg-slate-100 px-3 py-2 text-center dark:bg-slate-800/90">
                      {canEdit && (
                        <button
                          data-testid="sb-button-add-column"
                          onClick={addColumn}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title="Add column"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      )}
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {activeSheet.rows.map((row, ri) => (
                    <tr
                      key={row.id}
                      className="group transition-colors hover:bg-blue-500/[0.035] dark:hover:bg-blue-400/[0.055]"
                    >
                      {/* Row label */}
                      <td className="border-b border-r border-border/50 bg-muted/20 px-2 py-1 group-hover:bg-muted/40">
                        <div className="flex items-center gap-1">
                          <Input
                            value={fmtLabel(row.label)}
                            onChange={(e) => setRowLabel(ri, e.target.value)}
                            readOnly={!canEdit}
                            className="h-9 flex-1 border-0 bg-transparent px-2 text-sm font-medium text-foreground shadow-none focus-visible:ring-1 focus-visible:ring-primary"
                            data-testid={`sb-input-row-label-${ri}`}
                            dir="auto"
                          />
                          {canEdit && (
                            <button
                              data-testid={`sb-button-remove-row-${ri}`}
                              onClick={() =>
                                setPendingDelete({
                                  type: "row",
                                  idx: ri,
                                  label: fmtLabel(row.label) || `Row ${ri + 1}`,
                                })
                              }
                              className="text-muted-foreground hover:text-destructive shrink-0 transition-colors opacity-0 group-hover:opacity-100 touch:opacity-100"
                              style={{ visibility: "visible" }}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          )}
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
                            className={`border-b border-r border-border/50 px-0 py-0 ${isDiff ? "bg-muted/20" : isTotal ? "bg-blue-500/[0.075] dark:bg-blue-600/[0.13]" : ""} ${hiddenColIds.includes(col.id) ? "hidden" : ""}`}
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
                                  className={`h-10 px-3 flex items-center gap-1 text-sm font-medium tabular-nums select-none cursor-default
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
                                  readOnly={!canEdit}
                                  onKeyDown={(e) => handleCellKeyDown(e, ri, ci)}
                                  className={`h-10 border-0 bg-transparent px-3 text-sm font-medium shadow-none focus-visible:ring-1 focus-visible:ring-primary tabular-nums
                                    ${isNeg ? "text-red-500" : ""}
                                    ${isTextVal ? "text-left" : "text-center"}`}
                                  data-testid={`sb-input-cell-${ri}-${ci}`}
                                  dir="auto"
                                />
                              )}

                              {/* Link menu */}
                              {!isDiff && !isTotal && (canEdit || isLinked) && (
                                <StatusCellLinkMenu
                                  rowIdx={ri}
                                  colIdx={ci}
                                  isLinked={isLinked}
                                  isBroken={isBroken || isCyclic}
                                  linkInfo={linkInfo}
                                  canEdit={canEdit}
                                  sourceSheetIdx={srcSheetIdxForJump}
                                  onJumpToSource={setActiveIdx}
                                  onOpenLinkDialog={() => openLinkDialog(ri, ci)}
                                  onUnlink={() => unlinkCell(ri, ci)}
                                  onCopyAsManual={() => copyLinkValueAsManual(ri, ci)}
                                />
                              )}
                            </div>
                          </td>
                        );
                      })}
                      {/* Add column placeholder */}
                      <td className="border border-border" />
                    </tr>
                  ))}

                  {canEdit && (
                    <StatusAddRow
                      columnIds={activeSheet.columns.map((col) => col.id)}
                      hiddenColumnIds={hiddenColIds}
                      onAddRow={addRow}
                    />
                  )}

                  {/* Footer — DIFFERENCE row */}
                  {activeSheet.rows.length > 0 && (
                    <StatusDiffFooterRow
                      diffRow={diffRow}
                      columnIds={activeSheet.columns.map((col) => col.id)}
                      hiddenColumnIds={hiddenColIds}
                    />
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
