import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Printer, FileDown, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface PaymentReceiptHeaderActionsProps {
  canPrint: boolean;
  canExport: boolean;
  hasExport: boolean;
  printDisabledReason: string;
  handlePrint: () => void;
  handleExportVoucher?: (detailed: boolean) => void;
}

/** Print and Export controls in the payment/receipt voucher header strip. */
export function PaymentReceiptHeaderActions({
  canPrint,
  canExport,
  hasExport,
  printDisabledReason,
  handlePrint,
  handleExportVoucher,
}: PaymentReceiptHeaderActionsProps) {
  return (
    <>
      {/* Print */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={!canPrint ? "cursor-not-allowed" : ""}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canPrint}
              onClick={handlePrint}
              data-testid="button-print"
              className={cn("h-8 text-muted-foreground", !canPrint && "pointer-events-none")}
            >
              <Printer className="h-4 w-4" />
              <span className="hidden sm:inline ml-1.5">Print</span>
            </Button>
          </span>
        </TooltipTrigger>
        {!canPrint && (
          <TooltipContent side="bottom" className="max-w-xs text-center">
            {printDisabledReason}
          </TooltipContent>
        )}
      </Tooltip>

      {/* Export */}
      {hasExport && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={!canExport ? "cursor-not-allowed" : ""}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!canExport}
                    data-testid="button-export"
                    className={cn("h-8 text-muted-foreground", !canExport && "pointer-events-none")}
                  >
                    <FileDown className="h-4 w-4" />
                    <span className="hidden sm:inline ml-1.5">Export</span>
                    <ChevronDown className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => handleExportVoucher?.(false)} data-testid="export-summary">
                    <FileDown className="h-4 w-4 mr-2" />
                    Summary
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExportVoucher?.(true)} data-testid="export-detailed">
                    <FileDown className="h-4 w-4 mr-2" />
                    Detailed
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </TooltipTrigger>
          {!canExport && (
            <TooltipContent side="bottom" className="max-w-xs text-center">
              {printDisabledReason}
            </TooltipContent>
          )}
        </Tooltip>
      )}
    </>
  );
}
