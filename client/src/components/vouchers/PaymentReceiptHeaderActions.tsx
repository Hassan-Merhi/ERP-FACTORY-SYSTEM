import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExportButton, ReportExportMenu } from "@/components/export/ReportExportMenu";
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
            <ExportButton
              kind="print"
              iconOnlyOnPhone
              variant="ghost"
              size="sm"
              disabled={!canPrint}
              onClick={handlePrint}
              data-testid="button-print"
              className={cn("h-8 text-muted-foreground", !canPrint && "pointer-events-none")}
            />
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
              <ReportExportMenu
                variant="ghost"
                size="sm"
                disabled={!canExport}
                data-testid="button-export"
                className={cn("h-8 text-muted-foreground", !canExport && "pointer-events-none")}
                options={[
                  {
                    id: "voucher-summary",
                    label: "Summary",
                    kind: "excel",
                    testId: "export-summary",
                    onSelect: () => handleExportVoucher?.(false),
                  },
                  {
                    id: "voucher-detailed",
                    label: "Detailed",
                    kind: "excel",
                    testId: "export-detailed",
                    onSelect: () => handleExportVoucher?.(true),
                  },
                ]}
              />
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
