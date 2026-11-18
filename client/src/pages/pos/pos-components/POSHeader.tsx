import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useChristmasMode } from "@/hooks/useChristmasMode";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  FileDown,
  MoreHorizontal,
  Eye,
  Upload,
  Download,
  FileText,
  FileSpreadsheet,
  Save,
  Sheet,
  TreePine,
  Gift,
} from "lucide-react";
import { Link } from "wouter";

import type { AuthMe } from "@shared/apiTypes";
import { PosSaleHeader, PosSaleSubmitButton } from "./PosSaleHeader";
import type { Location, PosDraftSummary, PosMutationPending } from "./posTypes";

export interface POSHeaderProps {
  posUser?: AuthMe | null;
  editVoucherId?: string;
  activeLocation: Location | null;
  showPosImport: boolean;
  onExportInventory: () => void;
  onImportClick: () => void;
  onShowStockReport: () => void;
  navigate: (path: string) => void;
  saveMutation?: PosMutationPending;
  hasValidItems?: boolean;
  disableSave?: boolean;
  handleSaveSale?: () => void;
  lastAutosaved?: Date | null;
  drafts?: PosDraftSummary[];
  onOpenDraftDialog?: () => void;
  onUpdateDraft?: () => void;
  onSummaryExport?: () => void;
  onDetailedExport?: () => void;
  onExportTransaction?: () => void;
}

function useRelativeTime(date: Date | null | undefined) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!date) {
      setLabel(null);
      return;
    }
    const update = () => {
      const secs = Math.floor((Date.now() - date.getTime()) / 1000);
      if (secs < 10) setLabel("Autosaved just now");
      else if (secs < 60) setLabel(`Autosaved ${secs}s ago`);
      else setLabel(`Autosaved ${Math.floor(secs / 60)}m ago`);
    };
    update();
    const id = setInterval(update, 10000);
    return () => clearInterval(id);
  }, [date]);

  return label;
}

export function POSHeader({
  editVoucherId,
  showPosImport,
  onExportInventory,
  onImportClick,
  onShowStockReport,
  saveMutation,
  hasValidItems,
  disableSave,
  handleSaveSale,
  lastAutosaved,
  drafts = [],
  onOpenDraftDialog,
  onUpdateDraft,
  onSummaryExport,
  onDetailedExport,
  onExportTransaction,
}: POSHeaderProps) {
  const { t } = useApplicationLanguage();
  const autosaveLabel = useRelativeTime(lastAutosaved);
  const { settingQuery } = useChristmasMode();
  const showSeasonalArtwork =
    settingQuery.data?.enabled === true && (settingQuery.data?.visuals?.effects.gifts ?? true);

  return (
    <div className="hidden px-4 pt-4 lg:block" data-pos-desktop-header="true">
      <PosSaleHeader
        title={editVoucherId ? "Edit Transaction" : "Point of Sale"}
        subtitle={editVoucherId ? t("pos.modern.reviewSale") : t("pos.modern.createSale")}
        decoration={
          showSeasonalArtwork && (
            <div data-pos-seasonal-banner="true" aria-hidden="true">
              <TreePine className="h-10 w-10" />
              <Gift className="h-9 w-9" />
            </div>
          )
        }
        actions={
          <>
            {editVoucherId ? (
              <>
                {onExportTransaction && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onExportTransaction}
                    className="gap-2"
                    data-testid="button-export-transaction"
                    title="Export transaction to Excel (admin/dev only)"
                  >
                    <Sheet className="h-4 w-4" />
                    Export Excel
                  </Button>
                )}
              </>
            ) : (
              <>
                {autosaveLabel && <span className="text-xs text-muted-foreground">{autosaveLabel}</span>}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      data-testid="button-pos-options"
                      aria-label="Open POS options"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {showPosImport && (
                      <DropdownMenuItem onClick={onImportClick} className="cursor-pointer gap-2">
                        <Upload className="h-4 w-4" />
                        Import Sales
                      </DropdownMenuItem>
                    )}

                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                      onClick={onOpenDraftDialog}
                      className="cursor-pointer gap-2"
                      data-testid="button-load-draft"
                    >
                      <Download className="h-4 w-4" />
                      Load Draft{drafts.length > 0 ? ` (${drafts.length})` : ""}
                    </DropdownMenuItem>

                    {onUpdateDraft && (
                      <DropdownMenuItem
                        onClick={onUpdateDraft}
                        className="cursor-pointer gap-2"
                        data-testid="button-update-draft"
                      >
                        <Save className="h-4 w-4" />
                        Update Draft
                      </DropdownMenuItem>
                    )}

                    <DropdownMenuSeparator />

                    <DropdownMenuItem onClick={onSummaryExport} className="cursor-pointer gap-2">
                      <FileText className="h-4 w-4" />
                      Summary Export
                    </DropdownMenuItem>

                    <DropdownMenuItem onClick={onDetailedExport} className="cursor-pointer gap-2">
                      <FileSpreadsheet className="h-4 w-4" />
                      Detailed Export
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />

                    <DropdownMenuItem onClick={onShowStockReport} className="cursor-pointer gap-2">
                      <Eye className="h-4 w-4" />
                      Stock Report
                    </DropdownMenuItem>

                    <DropdownMenuItem onClick={onExportInventory} className="cursor-pointer gap-2">
                      <FileDown className="h-4 w-4" />
                      Export Inventory
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />

                    <DropdownMenuItem asChild>
                      <Link href="/pos-daybook" className="flex w-full cursor-pointer items-center gap-2">
                        <MoreHorizontal className="h-4 w-4" />
                        POS Daybook
                      </Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}

            {handleSaveSale && (
              <PosSaleSubmitButton
                onClick={handleSaveSale}
                disabled={saveMutation?.isPending || !hasValidItems || disableSave}
                data-testid="button-save-sale"
                pending={Boolean(saveMutation?.isPending)}
                pendingLabel="Saving..."
                label={editVoucherId ? "Update" : "Save"}
              />
            )}
          </>
        }
      />
    </div>
  );
}
