import { useEffect } from "react";
import { Link } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import SalesReportLegacy from "./SalesReportLegacy";

declare global {
  // Compatibility binding for the pre-existing Sales Report implementation.
  // The legacy module references selectedCompany directly in its stock-item query key.
  // This wrapper supplies the live CompanyContext value until that large page is split safely.
  var selectedCompany: ReturnType<typeof useCompany>["selectedCompany"] | undefined;
}

export default function SalesReport() {
  const { selectedCompany } = useCompany();
  globalThis.selectedCompany = selectedCompany;

  useEffect(
    () => () => {
      if (globalThis.selectedCompany === selectedCompany) {
        globalThis.selectedCompany = undefined;
      }
    },
    [selectedCompany],
  );

  return (
    <div className="min-w-0">
      {selectedCompany?.companyType !== "retail" && (
        <nav aria-label="Related sales reports" className="mb-3 flex flex-wrap items-center gap-2">
          <Link
            href="/stock-in-sales-report"
            className="inline-flex min-h-10 items-center rounded-lg border bg-card px-3 text-sm font-medium hover:bg-muted"
            data-testid="link-sales-report-stock-in-sales"
          >
            Stock In &amp; Sales
          </Link>
          {selectedCompany?.companyType === "erp" && (
            <Link
              href="/item-market-analysis"
              className="inline-flex min-h-10 items-center rounded-lg border bg-card px-3 text-sm font-medium hover:bg-muted"
              data-testid="link-sales-report-market-analysis"
            >
              Item Market Analysis
            </Link>
          )}
        </nav>
      )}
      <SalesReportLegacy />
    </div>
  );
}
