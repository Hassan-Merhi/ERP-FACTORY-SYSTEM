import { Workbook } from "@fortune-sheet/react";
import { PageHeader } from "@/components/PageHeader";
import "@fortune-sheet/react/dist/index.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, Plus, Upload, FileSpreadsheet, Trash2, Check, Loader2, Pencil } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
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
import { useSpreadsheetEditorState } from "./useSpreadsheetEditorState";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";

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

export default function SpreadsheetEditor() {
  const {
    sheetError,
    refetchSheet,
    refetchLibrary,
    libraryError,
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
  } = useSpreadsheetEditorState();

  if (openSheetId !== null) {
    return (
      <div
        className="-mx-3 sm:-mx-6 -mt-3 sm:-mt-6 flex flex-col"
        style={{ height: "calc(var(--app-viewport-height) - 56px)" }}
      >
        <div className="h-12 min-w-0 flex items-center gap-2 px-2 sm:px-3 border-b bg-background shrink-0">
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
              className="h-8 min-w-0 flex-1 max-w-xs text-sm font-medium"
              data-testid="input-spreadsheet-name"
            />
          ) : (
            <button
              className="group flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none"
              onClick={startRename}
              data-testid="button-rename-spreadsheet"
            >
              <span className="truncate text-sm font-medium">{sheetName}</span>
              <Pencil className="h-3 w-3 text-muted-foreground opacity-60 md:opacity-0 md:group-hover:opacity-100 touch:opacity-100 transition-opacity" />
            </button>
          )}
          <div className="hidden items-center gap-1 text-xs text-muted-foreground ml-1 sm:flex">
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
            <ExportButton iconOnlyOnPhone size="sm" onClick={handleDownload} data-testid="button-download-xlsx" />
          </div>
        </div>
        <div
          ref={containerRef}
          style={{ height: "calc(var(--app-viewport-height) - 104px)" }}
          className="overflow-visible"
          onMouseDown={markInteracted}
          onKeyDown={markInteracted}
          onTouchStart={markInteracted}
        >
          {sheetError && !openedSheet ? (
            <ErrorState onAction={() => void refetchSheet()} actionLabel="Try again" className="h-full" />
          ) : sheetLoading || !openedSheet ? (
            <LoadingState title="Loading spreadsheet…" className="h-full" />
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
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={handleUpload}
        data-testid="input-upload-xlsx"
      />
      <PageHeader title="Spreadsheets" subtitle="Shared workbooks — all users can view and edit">
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
        <Button size="sm" onClick={handleNew} disabled={createMutation.isPending} data-testid="button-new-spreadsheet">
          {createMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <Plus className="h-4 w-4 mr-1.5" />
          )}
          New Spreadsheet
        </Button>
      </PageHeader>

      {libraryLoading ? (
        <LoadingState className="py-16" />
      ) : libraryError && library.length === 0 ? (
        <ErrorState onAction={() => void refetchLibrary()} actionLabel="Try again" className="py-20" />
      ) : library.length === 0 ? (
        <EmptyState
          icon={FileSpreadsheet}
          title="No spreadsheets yet"
          description="Create a new spreadsheet or upload an existing .xlsx file"
          className="py-20"
          action={
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
          }
        />
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
                    className="shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 touch:opacity-100 transition-opacity h-7 w-7"
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
