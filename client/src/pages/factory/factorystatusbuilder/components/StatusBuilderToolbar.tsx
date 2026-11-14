import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { FileDown, LayoutGrid, Save, Upload } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl } from "@/lib/exportFile";

/** The Factory Sheets toolbar: template, Excel import/export, autosave state and Save. */
export function StatusBuilderToolbar({
  fileInputRef,
  onImportFile,
  importPending,
  onExport,
  exportDisabled,
  savedAt,
  isDirty,
  savePending,
  onSave,
  canEdit = true,
}: {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onImportFile: (file: File) => void;
  importPending: boolean;
  onExport: () => void;
  exportDisabled: boolean;
  savedAt: string | null;
  isDirty: boolean;
  savePending: boolean;
  onSave: () => void;
  /** False for read-only company roles: Import and Save are not offered. */
  canEdit?: boolean;
}) {
  const { toast } = useToast();
  const downloadTemplate = async () => {
    try {
      await downloadFromUrl("/api/factory/status-builder/sheets/template", {
        fileName: "factory-sheets-template.xlsx",
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
  return (
    <div className="flex items-center gap-2 border-b border-border/60 bg-gradient-to-r from-muted/70 via-card to-card px-4 py-3 flex-wrap">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600/10 text-blue-600 ring-1 ring-blue-500/20 dark:bg-blue-500/15 dark:text-blue-400">
        <LayoutGrid className="h-4 w-4" />
      </span>
      <span className="text-base font-semibold tracking-tight text-foreground mr-2">Factory Sheets</span>
      <div className="flex-1" />
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportFile(f);
          e.target.value = "";
        }}
        data-testid="sb-input-import-file"
      />
      <Button
        size="sm"
        variant="outline"
        onClick={() => void downloadTemplate()}
        data-testid="sb-button-download-template"
        className="rounded-lg border-border/70 bg-background/70 font-medium shadow-sm hover:bg-accent"
      >
        <FileDown className="h-3.5 w-3.5 mr-1.5" />
        Template
      </Button>
      {canEdit && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={importPending}
          data-testid="sb-button-import-excel"
          className="rounded-lg border-border/70 bg-background/70 font-medium shadow-sm hover:bg-accent"
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          Import Excel
        </Button>
      )}
      <ExportButton
        kind="excel"
        size="sm"
        variant="outline"
        onClick={onExport}
        disabled={exportDisabled}
        data-testid="sb-button-export-excel"
        className="rounded-lg border-border/70 bg-background/70 font-medium shadow-sm hover:bg-accent"
      />
      {savedAt && !isDirty && (
        <span className="text-xs text-muted-foreground" data-testid="sb-text-autosaved">
          Autosaved {savedAt}
        </span>
      )}
      {canEdit && (
        <Button
          size="sm"
          onClick={onSave}
          disabled={!isDirty || savePending}
          data-testid="sb-button-save"
          className="rounded-lg bg-blue-600 font-semibold text-white shadow-sm shadow-blue-600/15 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {savePending ? "Saving…" : "Save"}
        </Button>
      )}
    </div>
  );
}
