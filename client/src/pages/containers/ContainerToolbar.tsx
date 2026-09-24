import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Download, Plus, ChevronDown, RefreshCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getContainerSyncButtonLabel } from "@/i18n/containerSyncTranslations";

interface ContainerToolbarProps {
  onExportExcel: () => void;
  onExportAllFull: () => void;
  onSyncAll: () => void;
  isSyncing: boolean;
  showSyncAll: boolean;
}

export function ContainerToolbar({
  onExportExcel,
  onExportAllFull,
  onSyncAll,
  isSyncing,
  showSyncAll,
}: ContainerToolbarProps) {
  const { language } = useApplicationLanguage();
  const syncLabel = getContainerSyncButtonLabel(language);

  return (
    <div className="flex w-full flex-wrap gap-2 [&>*]:flex-auto sm:w-auto sm:[&>*]:flex-none">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-2" data-testid="button-export-dropdown">
            <Download className="h-4 w-4" />
            Export
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onExportExcel} data-testid="button-export-excel">
            <Download className="h-4 w-4 mr-2" />
            Export
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onExportAllFull} data-testid="button-export-all-full">
            <Download className="h-4 w-4 mr-2" />
            Export All (Full)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {showSyncAll && (
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          data-testid="button-sync-all-vouchers"
          onClick={onSyncAll}
          disabled={isSyncing}
          aria-label={syncLabel}
          title={syncLabel}
        >
          <RefreshCw className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
          {syncLabel}
        </Button>
      )}

      <Link href="/po-import">
        <Button className="gap-2" data-testid="button-add-container">
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </Link>
    </div>
  );
}
