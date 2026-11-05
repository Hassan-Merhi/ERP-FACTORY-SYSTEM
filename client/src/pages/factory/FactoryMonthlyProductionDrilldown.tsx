import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute, useSearch } from "wouter";
import { ArrowLeft, ChevronLeft, ChevronRight, Package, Search, Users } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Product = { id: number; name: string; articleCode: string };
type Worker = { workerId: number; workerName: string; quantity: number; weightKg: string };
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
type BaleResponse = {
  product: Product; months: string[]; workerId: number; page: number;
  limit: number; totalBales: number; bales: Bale[];
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
  const openBales = (worker: Worker) => {
    const params = new URLSearchParams({ months, name: worker.workerName });
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
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[500px] text-sm">
              <thead className="bg-muted"><tr>
                <th className="p-3 text-left">Worker</th>
                <th className="p-3 text-right">Bales produced</th>
                <th className="p-3 text-right">Weight (kg)</th>
              </tr></thead>
              <tbody>{filtered.map((worker) => <tr key={worker.workerId} className="border-t hover:bg-accent/30">
                <td className="p-3 font-medium">
                  <span className="inline-flex items-center gap-2"><Users className="h-4 w-4 text-muted-foreground" />{worker.workerName}</span>
                  {worker.workerId === 0 && <span className="ml-2 text-xs text-muted-foreground">(no worker recorded)</span>}
                </td>
                <td className="p-3 text-right">
                  <button type="button" className="font-bold text-primary underline-offset-4 hover:underline focus-visible:underline"
                    onClick={() => openBales(worker)} aria-label={"View " + worker.quantity + " bales for " + worker.workerName}
                    data-testid={"worker-production-bales-" + worker.workerId}>{format(worker.quantity)}</button>
                </td>
                <td className="p-3 text-right tabular-nums">{kg(worker.weightKg)}</td>
              </tr>)}</tbody>
              <tfoot className="bg-muted font-semibold"><tr>
                <td className="p-3">Total (all workers)</td>
                <td className="p-3 text-right">{format(data.totalBales)}</td>
                <td className="p-3 text-right">{kg(data.totalWeightKg)}</td>
              </tr></tfoot>
            </table>
            {filtered.length === 0 && <p className="p-6 text-center text-muted-foreground">No workers match your search.</p>}
          </div>
          <p className="text-xs text-muted-foreground">Click a worker's bale count to view the individual reference numbers. Unassigned bales are included so totals match the matrix.</p>
        </>}
  </main>;
}

export function FactoryMonthlyProductionBales() {
  const [, match] = useRoute("/factory/monthly-production-matrix/:productId/bales/:workerId");
  const [, navigate] = useLocation();
  const query = new URLSearchParams(useSearch());
  const months = query.get("months") ?? "";
  const name = query.get("name") || "Unassigned";
  const productId = Number(match?.productId);
  const workerId = Number(match?.workerId);
  const { selectedCompany } = useCompany();
  const [page, setPage] = useState(1);
  const enabled = Number.isSafeInteger(productId) && productId > 0 &&
    Number.isSafeInteger(workerId) && workerId >= 0 && validMonths(months);
  const { data, error, isLoading, isFetching, refetch } = useQuery<BaleResponse>({
    queryKey: companyQueryKey("/api/factory/monthly-production-matrix/bales", selectedCompany?.id, productId, workerId, months, page),
    enabled: !!selectedCompany?.id && enabled,
    queryFn: () => requestJson<BaleResponse>(
      "/api/factory/monthly-production-matrix/bales?" +
      periodQuery(productId, months) + "&workerId=" + workerId + "&page=" + page
    ),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  });
  const backToWorkers = () => navigate(root + "/" + productId + "/workers?months=" + encodeURIComponent(months));
  const totalPages = Math.max(1, Math.ceil((data?.totalBales ?? 0) / (data?.limit ?? 100)));

  return <main className="space-y-4 p-3 sm:p-5" data-testid="monthly-production-bales">
    <DrilldownBack onClick={backToWorkers} label="Back to workers" />
    <PageHeader title="Individual produced bales" subtitle={monthText(validMonths(months) ? months : "")} />
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
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[1000px] text-sm tabular-nums">
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
            {data.bales.length === 0 && <p className="p-6 text-center text-muted-foreground">No bales for this worker in the selected months.</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Showing {data.totalBales ? (data.page - 1) * data.limit + 1 : 0}–{Math.min(data.page * data.limit, data.totalBales)} of {format(data.totalBales)} bales</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
              <span className="text-sm tabular-nums">{page} / {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
            </div>
          </div>
        </>}
  </main>;
}
