import { ExportButton } from "@/components/export/ReportExportMenu";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

interface CustomerStatementExportsProps {
  customerId: string | undefined;
  filterDateFrom: string;
  filterDateTo: string;
  filterDestination: string;
}

/** Statement PDF/Excel exports for the current filters. Phones give them their own two-column row. */
export function CustomerStatementExports({
  customerId,
  filterDateFrom,
  filterDateTo,
  filterDestination,
}: CustomerStatementExportsProps) {
  const { toast } = useToast();
  const exportQuery = () => {
    const params = new URLSearchParams();
    if (filterDateFrom) params.set("dateFrom", filterDateFrom);
    if (filterDateTo) params.set("dateTo", filterDateTo);
    if (filterDestination) params.set("destination", filterDestination);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  };

  return (
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:items-center">
      <ExportButton
        kind="pdf"
        size="sm"
        onClick={() => {
          const url = `/api/factory/customers/${customerId}/statement/export-pdf${exportQuery()}`;
          if (!navigator.onLine) {
            window.print();
            return;
          }
          window.open(url, "_blank");
        }}
        data-testid="button-export-pdf"
      />
      <ExportButton
        size="sm"
        onClick={async () => {
          try {
            await downloadFromUrl(`/api/factory/customers/${customerId}/statement/export-excel${exportQuery()}`, {
              fileName: exportFileName(`customer statement ${customerId ?? ""}`, "xlsx", {
                from: filterDateFrom || undefined,
                to: filterDateTo || undefined,
              }),
            });
          } catch (error) {
            toast({
              title: "Export failed",
              description: error instanceof Error ? error.message : "Please try again.",
              variant: "destructive",
            });
          }
        }}
        data-testid="button-export-excel"
      />
    </div>
  );
}
