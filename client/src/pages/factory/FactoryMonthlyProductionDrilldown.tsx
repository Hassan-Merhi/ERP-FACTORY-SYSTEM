import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute, useSearch } from "wouter";
import { ArrowLeft, ChevronLeft, ChevronRight, Package, Search, Users } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOptionalApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";

type Product = { id: number; name: string; articleCode: string };
type Worker = { workerId: number; workerName: string; quantity: number; weightKg: string; monthlyBales: Record<string, number> };
type WorkerResponse = {
  product: Product; months: string[]; workers: Worker[];
  totalBales: number; totalWeightKg: number;
};
type Bale = {
  id: number; baleCode: string; referenceNumber: string; articleCode: string;
  productName: string; weightKg: string; quantity: number; status: string;
  stockEntryDate: string | null; finalizedAt: string | null;
  category: string | null; grade: string | null; workerName: string | null;
  locationName: string | null;
};
type DailyProductionGroup = {
  date: string; productName: string; quantity: number; weightKg: string;
};
type BaleView = "condensed" | "detailed";
type BaleResponse = {
  product: Product; months: string[]; workerId: number; page: number;
  view: BaleView; limit: number; totalBales: number; totalWeightKg: string;
  totalRows: number; groups: DailyProductionGroup[]; bales: Bale[];
};
const root = "/factory/monthly-production-matrix";
const validMonths = (raw: string) => {
  const months = raw.split(",");
  return months.length > 0 && months.length <= 240 &&
    months.every((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month));
};
const monthText = (months: string) => months.split(",").map((month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}).join(", ");
const format = (count: number) => count.toLocaleString();
const kg = (value: string | number) => Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 });
const dateLabel = (value: string | null) => value ? value.slice(0, 10) : "—";
const requestJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || "Unable to load production details");
  }
  return response.json();
};
const periodQuery = (productId: number, months: string) => {
  const params = new URLSearchParams({ productId: String(productId), months });
  return params.toString();
};

function DrilldownBack({ onClick, label }: { onClick: () => void; label: string }) {
  return <Button type="button" variant="outline" size="sm" onClick={onClick} className="gap-2">
    <ArrowLeft className="h-4 w-4" /> {label}
  </Button>;
}

export function FactoryMonthlyProductionWorkers() {
  const lang = useOptionalApplicationLanguage()?.language ?? "en";
  const dt = (key: Parameters<typeof duoMobileText>[0]) => duoMobileText(key, lang);
  const [, match] = useRoute("/factory/monthly-production-matrix/:productId/workers");
  const [, navigate] = useLocation();
  const searchParams = new URLSearchParams(useSearch());
  const months = searchParams.get("months") ?? "";
  const productId = Number(match?.productId);
  const { selectedCompany } = useCompany();
  const [search, setSearch] = useState("");
  const enabled = Number.isSafeInteger(productId) && productId > 0 && validMonths(months);
  const { data, error, isLoading, refetch } = useQuery<WorkerResponse>({
    queryKey: companyQueryKey("/api/factory/monthly-production-matrix/workers", selectedCompany?.id, productId, months),
    enabled: !!selectedCompany?.id && enabled,
    queryFn: () => requestJson<WorkerResponse>(
      "/api/factory/monthly-production-matrix/workers?" + periodQuery(productId, months)
    ),
    staleTime: 60_000,
  });
  const filtered = useMemo(() => (data?.workers ?? []).filter((worker) =>
    worker.workerName.toLowerCase().includes(search.toLowerCase()) ||
    String(worker.workerId).includes(search.trim())), [data?.workers, search]);
  const backToMatrix = () => navigate(root + "?months=" + encodeURIComponent(months));
  const openBales = (worker: Worker, selectedMonth?: string) => {
    const params = new URLSearchParams({ months: selectedMonth ?? months, name: worker.workerName });
    if (selectedMonth && selectedMonth !== months) params.set("returnMonths", months);
    navigate(root + "/" + productId + "/bales/" + worker.workerId + "?" + params.toString());
  };

  return <main className="space-y-4 p-3 sm:p-5" data-testid="monthly-production-workers">
    <DrilldownBack onClick={backToMatrix} label="Back to monthly matrix" />
    <PageHeader title="Monthly production by worker" subtitle={monthText(validMonths(months) ? months : "")} />
    {!enabled ? <p className="rounded-lg border p-6 text-destructive">Invalid item or month selection.</p> :
      isLoading ? <p className="rounded-lg border p-8 text-muted-foreground">Loading worker production…</p> :
        error ? <div className="rounded-lg border p-8 text-destructive">
          {error instanceof Error ? error.message : "Unable to load workers."}
          <Button variant="outline" size="sm" className="ml-3" onClick={() => void refetch()}>Retry</Button>
        </div> : data && <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{data.product.name}</h2>
              <p className="text-sm text-muted-foreground">{data.product.articleCode}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="rounded-lg border bg-card px-4 py-2"><span className="block text-xs text-muted-foreground">Total produced bales</span><strong className="text-xl tabular-nums">{format(data.totalBales)}</strong></div>
              <div className="rounded-lg border bg-card px-4 py-2"><span className="block text-xs text-muted-foreground">Total weight (kg)</span><strong className="text-xl tabular-nums">{kg(data.totalWeightKg)}</strong></div>
              <div className="rounded-lg border bg-card px-4 py-2"><span className="block text-xs text-muted-foreground">Workers / unassigned</span><strong className="text-xl tabular-nums">{format(data.workers.length)}</strong></div>
            </div>
          </div>
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search workers" aria-label="Search workers" className="pl-9" />
          </div>
          <p className="text-xs text-muted-foreground">
            Highest month per worker <strong className="text-emerald-600 dark:text-emerald-300">green</strong>
            {" · "}lowest <strong className="text-red-600 dark:text-red-300">red</strong>.
            Click a monthly count to see only that month's bales.
          </p>
          <section className="space-y-3 md:hidden phone-land:block" aria-label={dt("productionByMonth")} data-testid="monthly-production-workers-mobile">
            {filtered.map((worker) => {
              const values = data.months.map((month) => worker.monthlyBales[month] ?? 0);
              const min = Math.min(...values);
              const max = Math.max(...values);
              const hasRange = values.length > 1 && max !== min;
              return (
                <article key={worker.workerId} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-semibold">{worker.workerName}</h3>
                      {worker.workerId === 0 ? <span className="text-xs text-muted-foreground">{dt("noWorkerRecorded")}</span> : null}
                      <p className="mt-1 text-xs text-muted-foreground">{kg(worker.weightKg)} kg</p>
                    </div>
                    <button type="button" className="min-h-11 shrink-0 rounded-lg bg-primary/10 px-3 font-semibold text-primary tabular-nums"
                      onClick={() => openBales(worker)}
                      aria-label={`${dt("workerBales")}: ${worker.workerName} · ${worker.quantity}`}
                      data-testid={`worker-mobile-bales-${worker.workerId}`}>
                      {format(worker.quantity)} <span className="text-xs font-normal">{dt("bales")}</span>
                    </button>
                  </div>
                  <details className="mt-3 rounded-lg border bg-muted/20">
                    <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">{dt("productionByMonth")} · {data.months.length}</summary>
                    <div className="grid grid-cols-2 gap-2 border-t p-2">
                      {data.months.map((month, index) => {
                        const value = values[index];
                        const accent = hasRange && value === max
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : hasRange && value === min
                            ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-background";
                        return (
                          <button key={month} type="button" disabled={value === 0}
                            className={`min-h-11 rounded-lg border p-2 text-left disabled:opacity-60 ${accent}`}
                            onClick={() => openBales(worker, month)}
                            aria-label={`${dt("workerBales")}: ${worker.workerName} · ${monthText(month)} · ${value}`}
                            data-testid={`worker-mobile-month-${worker.workerId}-${month}`}>
                            <span className="block text-xs">{monthText(month)}</span>
                            <strong className="text-lg tabular-nums">{format(value)}</strong>
                          </button>
                        );
                      })}
                    </div>
                  </details>
                </article>
              );
            })}
            {!filtered.length && <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{dt("noMatchingWorkers")}</p>}
          </section>
          <div className="hidden overflow-auto rounded-xl border bg-card md:block phone-land:hidden" style={{ maxHeight: "calc(100dvh - 315px)" }}>
            <table className="min-w-max w-full border-separate border-spacing-0 text-sm tabular-nums">
              <thead className="sticky top-0 z-20 bg-muted text-foreground"><tr>
                <th className="sticky left-0 z-30 min-w-64 border-b border-r bg-muted p-3 text-left">Worker</th>
                {data.months.map((month) =>
                  <th key={month} className="min-w-24 whitespace-nowrap border-b border-r px-3 py-2 text-right">{monthText(month)}</th>
                )}
                <th className="min-w-28 whitespace-nowrap border-b border-r p-3 text-right">Weight (kg)</th>
                <th className="sticky right-0 z-30 min-w-24 border-b bg-muted p-3 text-right">Total bales</th>
              </tr></thead>
              <tbody>{filtered.map((worker) => {
                const values = data.months.map((month) => worker.monthlyBales[month] ?? 0);
                const min = Math.min(...values);
                const max = Math.max(...values);
                const hasRange = values.length > 1 && min !== max;
                return <tr key={worker.workerId} className="group hover:bg-accent/30">
                  <td className="sticky left-0 z-10 border-b border-r bg-card p-3 font-medium group-hover:bg-accent/30">
                    <span className="inline-flex items-center gap-2"><Users className="h-4 w-4 shrink-0 text-muted-foreground" />{worker.workerName}</span>
                    {worker.workerId === 0 && <span className="ml-2 text-xs text-muted-foreground">(no worker recorded)</span>}
                  </td>
                  {values.map((value, index) => {
                    const month = data.months[index];
                    const accent = hasRange && value === max
                      ? "bg-emerald-100 text-emerald-800 font-bold dark:bg-emerald-950/50 dark:text-emerald-300"
                      : hasRange && value === min
                        ? "bg-red-100 text-red-800 font-bold dark:bg-red-950/50 dark:text-red-300" : "";
                    return <td key={month} className={"border-b border-r px-3 py-2 text-right " + accent}
                      title={monthText(month) + ": " + format(value) + " bales"}>
                      {value > 0 ? <button type="button"
                        className="font-semibold underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        onClick={() => openBales(worker, month)}
                        aria-label={"View " + format(value) + " bales for " + worker.workerName + " in " + monthText(month)}
                        data-testid={"worker-production-month-" + worker.workerId + "-" + month}>{format(value)}</button> : format(value)}
                    </td>;
                  })}
                  <td className="border-b border-r p-3 text-right">{kg(worker.weightKg)}</td>
                  <td className="sticky right-0 z-10 border-b bg-card p-3 text-right group-hover:bg-accent/30">
                    <button type="button" className="font-bold text-primary underline-offset-4 hover:underline focus-visible:underline"
                      onClick={() => openBales(worker)} aria-label={"View " + worker.quantity + " bales for " + worker.workerName}
                      data-testid={"worker-production-bales-" + worker.workerId}>{format(worker.quantity)}</button>
                  </td>
                </tr>;
              })}</tbody>
              <tfoot className="sticky bottom-0 z-20 bg-muted font-semibold"><tr>
                <td className="sticky left-0 z-10 border-t border-r bg-muted p-3">Total (all workers)</td>
                {data.months.map((month) =>
                  <td key={month} className="border-t border-r px-3 py-2 text-right">
                    {format(data.workers.reduce((sum, worker) => sum + (worker.monthlyBales[month] ?? 0), 0))}
                  </td>
                )}
                <td className="border-t border-r p-3 text-right">{kg(data.totalWeightKg)}</td>
                <td className="sticky right-0 z-10 border-t bg-muted p-3 text-right">{format(data.totalBales)}</td>
              </tr></tfoot>
            </table>
            {filtered.length === 0 && <p className="p-6 text-center text-muted-foreground">No workers match your search.</p>}
          </div>
          <p className="text-xs text-muted-foreground">Click a worker's bale count to view the individual reference numbers. Unassigned bales are included so totals match the matrix.</p>
        </>}
  </main>;
}

export function FactoryMonthlyProductionBales() {
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
  const enabled = Number.isSafeInteger(productId) && productId > 0 &&
    Number.isSafeInteger(workerId) && workerId >= 0 && validMonths(months);
  const { data, error, isLoading, isFetching, refetch } = useQuery<BaleResponse>({
    queryKey: companyQueryKey("/api/factory/monthly-production-matrix/bales", selectedCompany?.id, productId, workerId, months, view, page),
    enabled: !!selectedCompany?.id && enabled,
    queryFn: () => requestJson<BaleResponse>(
      "/api/factory/monthly-production-matrix/bales?" +
      periodQuery(productId, months) + "&workerId=" + workerId + "&page=" + page + "&view=" + view
    ),
    staleTime: 60_000,
  });
  const backToWorkers = () => navigate(root + "/" + productId + "/workers?months=" + encodeURIComponent(query.get("returnMonths") || months));
  const totalPages = Math.max(1, Math.ceil((data?.totalRows ?? 0) / (data?.limit ?? 100)));

  return <main className="space-y-4 p-3 sm:p-5" data-testid="monthly-production-bales">
    <DrilldownBack onClick={backToWorkers} label="Back to workers" />
    <PageHeader title="Produced bales" subtitle={monthText(validMonths(months) ? months : "")} />
    {!enabled ? <p className="rounded-lg border p-6 text-destructive">Invalid worker or month selection.</p> :
      isLoading ? <p className="rounded-lg border p-8 text-muted-foreground">Loading bale details…</p> :
        error ? <div className="rounded-lg border p-8 text-destructive">
          {error instanceof Error ? error.message : "Unable to load bales."}
          <Button variant="outline" size="sm" className="ml-3" onClick={() => void refetch()}>Retry</Button>
        </div> : data && <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{data.product.name}</h2>
              <p className="text-sm text-muted-foreground">{data.product.articleCode} · Worker: <strong>{name}</strong></p>
            </div>
            <div className="rounded-lg border bg-card px-4 py-2">
              <span className="block text-xs text-muted-foreground">Total produced bales</span>
              <strong className="inline-flex items-center gap-2 text-xl tabular-nums"><Package className="h-5 w-5" />{format(data.totalBales)}</strong>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {view === "condensed" ? "Grouped by production date · Qty = number of bales" : "Individual bales with reference numbers and full details"}
            </p>
            <div className="inline-flex items-center gap-1 rounded-lg border bg-muted/40 p-1" role="group" aria-label="Bale table view">
              <Button type="button" size="sm" variant={view === "condensed" ? "default" : "ghost"}
                aria-pressed={view === "condensed"} data-testid="bales-view-condensed"
                onClick={() => changeView("condensed")}>Condensed</Button>
              <Button type="button" size="sm" variant={view === "detailed" ? "default" : "ghost"}
                aria-pressed={view === "detailed"} data-testid="bales-view-detailed"
                onClick={() => changeView("detailed")}>Detailed</Button>
            </div>
          </div>
          <section className="space-y-3 md:hidden phone-land:block" aria-label={`${dt("produced")} ${dt("bales")}`} data-testid="monthly-production-bales-mobile">
            {view === "condensed" ? data.groups.map((group) => (
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
            )) : data.bales.map((bale) => (
              <article key={bale.id} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-xs text-muted-foreground">{dt("referenceNumber")}</span>
                    <strong className="block break-all font-mono text-sm">{bale.referenceNumber}</strong>
                    <span className="block break-all text-xs text-muted-foreground">{bale.baleCode}</span>
                  </div>
                  <span className="rounded-lg bg-muted px-2 py-1 text-xs">{bale.status.replaceAll("_", " ")}</span>
                </div>
                <h3 className="mt-2 break-words text-sm font-medium">{bale.productName || data.product.name}</h3>
                <p className="break-all text-xs text-muted-foreground">{bale.articleCode || data.product.articleCode}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <span>{dt("date")}: {dateLabel(bale.stockEntryDate || bale.finalizedAt)}</span>
                  <span>{dt("weightKg")}: {kg(bale.weightKg)}</span>
                  <span>{dt("quantity")}: {format(bale.quantity)}</span>
                  <span className="break-words">{[bale.category, bale.grade].filter(Boolean).join(" · ") || "—"}</span>
                  <span className="col-span-2 break-words">{dt("location")}: {bale.locationName || "—"}</span>
                </div>
              </article>
            ))}
            {data.totalRows === 0 && <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">{dt("noBales")}</p>}
          </section>
          <div className="hidden overflow-x-auto rounded-xl border bg-card md:block phone-land:hidden">
            {view === "condensed" ? (
              <table className="w-full min-w-[420px] text-sm tabular-nums" data-testid="bales-condensed-table">
                <thead className="bg-muted"><tr>
                  <th className="p-2.5 text-left">Date</th>
                  <th className="p-2.5 text-left">Product name</th>
                  <th className="p-2.5 text-right">Qty</th>
                  <th className="p-2.5 text-right">Weight (kg)</th>
                </tr></thead>
                <tbody>{data.groups.map((group) => (
                  <tr key={group.date} className="border-t hover:bg-accent/30">
                    <td className="whitespace-nowrap px-2.5 py-2">{dateLabel(group.date)}</td>
                    <td className="px-2.5 py-2 font-medium">{group.productName}</td>
                    <td className="px-2.5 py-2 text-right font-semibold">{format(group.quantity)}</td>
                    <td className="px-2.5 py-2 text-right">{kg(group.weightKg)}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : (
            <table className="w-full min-w-[1000px] text-sm tabular-nums" data-testid="bales-detailed-table">
              <thead className="bg-muted"><tr>
                <th className="p-3 text-left">Reference number</th>
                <th className="p-3 text-left">Bale code</th>
                <th className="p-3 text-left">Stock entry date</th>
                <th className="p-3 text-left">Product / article</th>
                <th className="p-3 text-right">Weight (kg)</th>
                <th className="p-3 text-right">Qty on bale</th>
                <th className="p-3 text-left">Category / grade</th>
                <th className="p-3 text-left">Location</th>
                <th className="p-3 text-left">Status</th>
              </tr></thead>
              <tbody>{data.bales.map((bale) => <tr key={bale.id} className="border-t hover:bg-accent/30">
                <td className="p-3 font-semibold">{bale.referenceNumber}</td>
                <td className="p-3">{bale.baleCode}</td>
                <td className="p-3">{dateLabel(bale.stockEntryDate || bale.finalizedAt)}</td>
                <td className="p-3"><span className="block font-medium">{bale.productName || data.product.name}</span><span className="text-xs text-muted-foreground">{bale.articleCode || data.product.articleCode}</span></td>
                <td className="p-3 text-right">{kg(bale.weightKg)}</td>
                <td className="p-3 text-right">{format(bale.quantity)}</td>
                <td className="p-3">{[bale.category, bale.grade].filter(Boolean).join(" · ") || "—"}</td>
                <td className="p-3">{bale.locationName || "—"}</td>
                <td className="p-3">{bale.status.replaceAll("_", " ")}</td>
              </tr>)}</tbody>
            </table>
            )}
            {data.totalRows === 0 && <p className="p-6 text-center text-muted-foreground">No bales for this worker in the selected months.</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Showing {data.totalRows ? (data.page - 1) * data.limit + 1 : 0}–{Math.min(data.page * data.limit, data.totalRows)} of {format(data.totalRows)} {view === "condensed" ? "production dates" : "bales"}</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
              <span className="text-sm tabular-nums">{page} / {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
            </div>
          </div>
        </>}
  </main>;
}
