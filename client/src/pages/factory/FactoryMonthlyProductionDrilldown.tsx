import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute, useSearch } from "wouter";
import { ChevronLeft, ChevronRight, Package } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";
import {
  DrilldownBack,
  format,
  kg,
  monthText,
  periodQuery,
  requestJson,
  root,
  validMonths,
  type Bale,
  type DailyProductionGroup,
  type Product,
} from "./FactoryMonthlyProductionWorkers";
export { FactoryMonthlyProductionWorkers } from "./FactoryMonthlyProductionWorkers";
type BaleView = "condensed" | "detailed";
type BaleResponse = {
  product: Product;
  months: string[];
  workerId: number;
  page: number;
  view: BaleView;
  limit: number;
  totalBales: number;
  totalWeightKg: string;
  totalRows: number;
  groups: DailyProductionGroup[];
  bales: Bale[];
};
const dateLabel = (value: string | null) => (value ? value.slice(0, 10) : "—");

function useFactoryMonthlyProductionBalesState() {
  const lang = useOptionalApplicationLanguage()?.language ?? "en";
  const dt = (key: Parameters<typeof duoMobileText>[0]) => duoMobileText(key, lang);
  const [, match] = useRoute("/factory/monthly-production-matrix/:productId/bales/:workerId");
  const [, navigate] = useLocation();
  const query = new URLSearchParams(useSearch());
  const months = query.get("months") ?? "";
  const name = query.get("name") || "Unassigned";
  const productId = Number(match?.productId);
  const workerId = Number(match?.workerId);
  const { selectedCompany } = useCompany();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<BaleView>("condensed");
  const changeView = (nextView: BaleView) => {
    setView(nextView);
    setPage(1);
  };
  const enabled =
    Number.isSafeInteger(productId) &&
    productId > 0 &&
    Number.isSafeInteger(workerId) &&
    workerId >= 0 &&
    validMonths(months);
  const { data, error, isLoading, isFetching, refetch } = useQuery<BaleResponse>({
    queryKey: companyQueryKey(
      "/api/factory/monthly-production-matrix/bales",
      selectedCompany?.id,
      productId,
      workerId,
      months,
      view,
      page
    ),
    enabled: !!selectedCompany?.id && enabled,
    queryFn: () =>
      requestJson<BaleResponse>(
        "/api/factory/monthly-production-matrix/bales?" +
          periodQuery(productId, months) +
          "&workerId=" +
          workerId +
          "&page=" +
          page +
          "&view=" +
          view
      ),
    staleTime: 60_000,
  });
  const backToWorkers = () =>
    navigate(root + "/" + productId + "/workers?months=" + encodeURIComponent(query.get("returnMonths") || months));
  const totalPages = Math.max(1, Math.ceil((data?.totalRows ?? 0) / (data?.limit ?? 100)));
  return {
    backToWorkers,
    changeView,
    data,
    dt,
    enabled,
    error,
    isFetching,
    isLoading,
    months,
    name,
    page,
    refetch,
    setPage,
    totalPages,
    view,
  };
}

export function FactoryMonthlyProductionBales() {
  const {
    backToWorkers,
    changeView,
    data,
    dt,
    enabled,
    error,
    isFetching,
    isLoading,
    months,
    name,
    page,
    refetch,
    setPage,
    totalPages,
    view,
  } = useFactoryMonthlyProductionBalesState();

  return (
    <main className="space-y-4 p-3 sm:p-5" data-testid="monthly-production-bales">
      <DrilldownBack onClick={backToWorkers} label="Back to workers" />
      <PageHeader title="Produced bales" subtitle={monthText(validMonths(months) ? months : "")} />
      {!enabled ? (
        <p className="rounded-lg border p-6 text-destructive">Invalid worker or month selection.</p>
      ) : isLoading ? (
        <p className="rounded-lg border p-8 text-muted-foreground">Loading bale details…</p>
      ) : error ? (
        <div className="rounded-lg border p-8 text-destructive">
          {error instanceof Error ? error.message : "Unable to load bales."}
          <Button variant="outline" size="sm" className="ml-3" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        data && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{data.product.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {data.product.articleCode} · Worker: <strong>{name}</strong>
                </p>
              </div>
              <div className="rounded-lg border bg-card px-4 py-2">
                <span className="block text-xs text-muted-foreground">Total produced bales</span>
                <strong className="inline-flex items-center gap-2 text-xl tabular-nums">
                  <Package className="h-5 w-5" />
                  {format(data.totalBales)}
                </strong>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {view === "condensed"
                  ? "Grouped by production date · Qty = number of bales"
                  : "Individual bales with reference numbers and full details"}
              </p>
              <div
                className="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1"
                role="group"
                aria-label="Bale table view"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={view === "condensed" ? "default" : "ghost"}
                  aria-pressed={view === "condensed"}
                  data-testid="bales-view-condensed"
                  onClick={() => changeView("condensed")}
                >
                  Condensed
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={view === "detailed" ? "default" : "ghost"}
                  aria-pressed={view === "detailed"}
                  data-testid="bales-view-detailed"
                  onClick={() => changeView("detailed")}
                >
                  Detailed
                </Button>
              </div>
            </div>
            <section
              className="space-y-3 md:hidden phone-land:block"
              aria-label={`${dt("produced")} ${dt("bales")}`}
              data-testid="monthly-production-bales-mobile"
            >
              {view === "condensed"
                ? data.groups.map((group) => (
                    <article key={group.date} className="rounded-xl border bg-card p-3 shadow-sm">
                      <span className="text-xs text-muted-foreground">{dateLabel(group.date)}</span>
                      <h3 className="mt-1 break-words text-sm font-semibold">{group.productName}</h3>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                        <div className="rounded-lg bg-muted/30 p-2">
                          <span className="block text-xs text-muted-foreground">{dt("quantity")}</span>
                          <strong className="tabular-nums">{format(group.quantity)}</strong>
                        </div>
                        <div className="rounded-lg bg-muted/30 p-2">
                          <span className="block text-xs text-muted-foreground">{dt("weightKg")}</span>
                          <strong className="tabular-nums">{kg(group.weightKg)}</strong>
                        </div>
                      </div>
                    </article>
                  ))
                : data.bales.map((bale) => (
                    <article key={bale.id} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="text-xs text-muted-foreground">{dt("referenceNumber")}</span>
                          <strong className="block break-all font-mono text-sm">{bale.referenceNumber}</strong>
                          <span className="block break-all text-xs text-muted-foreground">{bale.baleCode}</span>
                        </div>
                        <span className="rounded-lg bg-muted px-2 py-1 text-xs">
                          {bale.status.replaceAll("_", " ")}
                        </span>
                      </div>
                      <h3 className="mt-2 break-words text-sm font-medium">{bale.productName || data.product.name}</h3>
                      <p className="break-all text-xs text-muted-foreground">
                        {bale.articleCode || data.product.articleCode}
                      </p>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                        <span>
                          {dt("date")}: {dateLabel(bale.stockEntryDate || bale.finalizedAt)}
                        </span>
                        <span>
                          {dt("weightKg")}: {kg(bale.weightKg)}
                        </span>
                        <span>
                          {dt("quantity")}: {format(bale.quantity)}
                        </span>
                        <span className="break-words">
                          {[bale.category, bale.grade].filter(Boolean).join(" · ") || "—"}
                        </span>
                        <span className="col-span-2 break-words">
                          {dt("location")}: {bale.locationName || "—"}
                        </span>
                      </div>
                    </article>
                  ))}
              {data.totalRows === 0 && (
                <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{dt("noBales")}</p>
              )}
            </section>
            <div className="hidden overflow-x-auto rounded-xl border bg-card md:block phone-land:hidden">
              {view === "condensed" ? (
                <table className="w-full min-w-[420px] text-sm tabular-nums" data-testid="bales-condensed-table">
                  <thead className="bg-muted">
                    <tr>
                      <th className="p-2.5 text-left">Date</th>
                      <th className="p-2.5 text-left">Product name</th>
                      <th className="p-2.5 text-right">Qty</th>
                      <th className="p-2.5 text-right">Weight (kg)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.groups.map((group) => (
                      <tr key={group.date} className="border-t hover:bg-accent/30">
                        <td className="whitespace-nowrap px-2.5 py-2">{dateLabel(group.date)}</td>
                        <td className="px-2.5 py-2 font-medium">{group.productName}</td>
                        <td className="px-2.5 py-2 text-right font-semibold">{format(group.quantity)}</td>
                        <td className="px-2.5 py-2 text-right">{kg(group.weightKg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full min-w-[1000px] text-sm tabular-nums" data-testid="bales-detailed-table">
                  <thead className="bg-muted">
                    <tr>
                      <th className="p-3 text-left">Reference number</th>
                      <th className="p-3 text-left">Bale code</th>
                      <th className="p-3 text-left">Stock entry date</th>
                      <th className="p-3 text-left">Product / article</th>
                      <th className="p-3 text-right">Weight (kg)</th>
                      <th className="p-3 text-right">Qty on bale</th>
                      <th className="p-3 text-left">Category / grade</th>
                      <th className="p-3 text-left">Location</th>
                      <th className="p-3 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bales.map((bale) => (
                      <tr key={bale.id} className="border-t hover:bg-accent/30">
                        <td className="p-3 font-semibold">{bale.referenceNumber}</td>
                        <td className="p-3">{bale.baleCode}</td>
                        <td className="p-3">{dateLabel(bale.stockEntryDate || bale.finalizedAt)}</td>
                        <td className="p-3">
                          <span className="block font-medium">{bale.productName || data.product.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {bale.articleCode || data.product.articleCode}
                          </span>
                        </td>
                        <td className="p-3 text-right">{kg(bale.weightKg)}</td>
                        <td className="p-3 text-right">{format(bale.quantity)}</td>
                        <td className="p-3">{[bale.category, bale.grade].filter(Boolean).join(" · ") || "—"}</td>
                        <td className="p-3">{bale.locationName || "—"}</td>
                        <td className="p-3">{bale.status.replaceAll("_", " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {data.totalRows === 0 && (
                <p className="p-6 text-center text-muted-foreground">
                  No bales for this worker in the selected months.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Showing {data.totalRows ? (data.page - 1) * data.limit + 1 : 0}–
                {Math.min(data.page * data.limit, data.totalRows)} of {format(data.totalRows)}{" "}
                {view === "condensed" ? "production dates" : "bales"}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || isFetching}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" /> Previous
                </Button>
                <span className="text-sm tabular-nums">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || isFetching}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )
      )}
    </main>
  );
}
