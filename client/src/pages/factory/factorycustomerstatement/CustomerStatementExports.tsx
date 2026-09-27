import { Download, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  const exportQuery = () => {
    const params = new URLSearchParams();
    if (filterDateFrom) params.set("dateFrom", filterDateFrom);
    if (filterDateTo) params.set("dateTo", filterDateTo);
    if (filterDestination) params.set("destination", filterDestination);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  };

  return (
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-shrink-0 sm:items-center">
      <Button
        variant="outline"
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
      >
        <Download className="mr-2 h-4 w-4" />
        Export PDF
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          window.open(`/api/factory/customers/${customerId}/statement/export-excel${exportQuery()}`, "_blank");
        }}
        data-testid="button-export-excel"
      >
        <FileSpreadsheet className="mr-2 h-4 w-4" />
        Export Excel
      </Button>
    </div>
  );
}
