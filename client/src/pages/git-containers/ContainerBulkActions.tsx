import { Loader2, MessageCircle, Upload, Download, ChevronDown, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ContainerBulkActionsProps {
  className?: string;
  waSending: boolean;
  onImportClick: () => void;
  onSendWhatsApp: () => void;
  onPrint: () => void;
}

export function ContainerBulkActions({
  waSending,
  onImportClick,
  onSendWhatsApp,
  onPrint,
  className,
}: ContainerBulkActionsProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="default" data-testid="button-otw-actions">
            Actions
            <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onImportClick} data-testid="menu-import-excel">
            <Upload className="h-4 w-4 mr-2" />
            Import Tracking Excel
          </DropdownMenuItem>
          <DropdownMenuItem asChild data-testid="menu-download-template">
            <a href="/api/git/containers/import-template.xlsx" target="_blank">
              <Download className="h-4 w-4 mr-2" />
              Download Excel Template
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSendWhatsApp} disabled={waSending} data-testid="menu-send-whatsapp">
            {waSending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <MessageCircle className="h-4 w-4 mr-2" />}
            Send to WhatsApp Group
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onPrint} data-testid="menu-print-pdf">
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Export PDF / Print
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
