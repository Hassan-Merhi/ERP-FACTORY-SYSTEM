import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { type PressingReportFilters, type PressingReportColumn } from "@shared/pressingReportContracts";
import {
  exportPressingReport, fetchPressingReport, pressingCell,
  type PressingDetailRow, type PressingReportOptions,
} from "./pressing-scanner/pressingReportClient";
import PressingCorrectionReview from "./PressingCorrectionReview";

const ROOT = "/api/factory/pressing-machines/report";
const COLUMNS: PressingReportColumn[] = [
  "referenceNumber", "articleCode", "productName", "weightKg", "operatorName", "confirmedAt",
];
const today = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2,"0"),
    String(now.getDate()).padStart(2,"0")].join("-");
};
const formatError = (error: unknown) =>
  error instanceof Error ? error.message : "Could not load pressing scans";

export default function PressingHistoryReport({ active, companyId, userId }: {
  active: boolean; companyId: number; userId: string;
}) {
  const { toast } = useToast();
  const [filters, setFilters] = useState<PressingReportFilters>({
    from: today(), to: today(), status: "active", mode: "detailed", page: 1, limit: 100,
  });
  const [search, setSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [showCorrections, setShowCorrections] = useState(false);
  const [initialDate, setInitialDate] = useState(false);
  const invalidDates = Boolean(filters.from && filters.to && filters.from > filters.to);
  const key = [ROOT, "data", companyId, userId];

  const options = useQuery<PressingReportOptions>({
    queryKey: [ROOT, "options", companyId, userId],
    enabled: active,
    queryFn: async () => {
      const response = await fetch(ROOT + "/options", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Could not load user filters");
      return response.json();
    },
    staleTime: 60000, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const day = options.data?.serverToday;
    if (!day || initialDate) return;
    setInitialDate(true);
    setFilters(current => ({ ...current, from: day, to: day, page: 1 }));
  }, [options.data?.serverToday, initialDate]);

  const report = useQuery({
    queryKey: [...key, filters],
    enabled: active && !invalidDates,
    queryFn: () => fetchPressingReport(filters),
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const update = (value: Partial<PressingReportFilters>) =>
    setFilters(current => ({ ...current, ...value, asOf: undefined, page: 1 }));
  const detail = (report.data?.rows || []).filter(
    (row): row is PressingDetailRow => "id" in row,
  );
  const total = report.data?.summary;
  const pageCount = Math.max(1, Math.ceil((report.data?.total || 0) / filters.limit));
  const canSeeEveryone = options.data?.canViewAll === true;

  async function excel() {
    if (exporting || invalidDates) return;
    setExporting(true);
    try {
      await exportPressingReport(filters, COLUMNS);
      toast({ title: "Pressing scans exported", description: "Excel includes every matching page." });
    } catch (error) {
      toast({ title: "Export failed", description: formatError(error), variant: "destructive" });
    } finally { setExporting(false); }
  }
  return (
    <section className="min-w-0 space-y-3" data-testid="pressing-history-report">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-base">Scanned Bales</h3>
        <Button size="sm" variant="outline" disabled={exporting || invalidDates}
          onClick={() => void excel()}>
          <Download className="mr-2 h-4 w-4" />{exporting ? "Exporting…" : "Export Excel"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => {
          const day = options.data?.serverToday || today();
          update({ from: day, to: day });
        }}>Today</Button>
        <Button size="sm" variant="outline" onClick={() => {
          const day = options.data?.serverToday || today();
          update({ from: day.slice(0,7) + "-01", to: day });
        }}>This Month</Button>
        <Button size="sm" variant="outline" onClick={() =>
          update({ from: undefined, to: undefined })}>All Time</Button>
        <Button size="sm" variant="outline" onClick={() =>
          void queryClient.invalidateQueries({ queryKey: key })}>
          <RefreshCw className="mr-1 h-4 w-4" />Refresh
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="text-xs space-y-1">From
          <Input type="date" value={filters.from || ""}
            onChange={e => update({ from: e.target.value || undefined })} />
        </label>
        <label className="text-xs space-y-1">To
          <Input type="date" value={filters.to || ""}
            onChange={e => update({ to: e.target.value || undefined })} />
        </label>
        {canSeeEveryone && (
          <label className="text-xs space-y-1">User
            <select aria-label="Pressing user filter" value={filters.userId || ""}
              className="h-10 w-full rounded-md border bg-background px-2 text-sm"
              onChange={e => update({ userId: e.target.value || undefined })}>
              <option value="">All users</option>
              {(options.data?.operators || []).map(operator =>
                <option key={operator.userId} value={operator.userId}>{operator.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs space-y-1">Barcode / article
          <Input placeholder="Search" value={search}
            onChange={e => {
              setSearch(e.target.value);
              update({ search: e.target.value || undefined });
            }} />
        </label>
        {canSeeEveryone && <label className="text-xs space-y-1">Status
          <select value={filters.status} aria-label="Pressing confirmation status"
            className="h-10 w-full rounded-md border bg-background px-2 text-sm"
            onChange={e => update({ status: e.target.value as PressingReportFilters["status"] })}>
            <option value="active">Confirmed</option>
            <option value="voided">Voided</option>
            <option value="all">All</option>
          </select>
        </label>}
      </div>
      {invalidDates && <p role="alert" className="text-sm text-destructive">From date cannot exceed To date.</p>}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-3 text-sm">
        <span><strong className="text-lg">{Number(total?.totalBales || 0).toLocaleString()}</strong> bales scanned</span>
        <span><strong className="text-lg">{Number(total?.totalKg || 0).toLocaleString(undefined, { maximumFractionDigits: 3 })}</strong> KG</span>
        {canSeeEveryone && Number(total?.voidedBales || 0) > 0 &&
          <span className="text-muted-foreground">{total?.voidedBales} voided</span>}
      </div>
      {report.isLoading && <p className="text-sm text-muted-foreground">Loading scans…</p>}
      {report.isError && <p role="alert" className="text-sm text-destructive">{formatError(report.error)}</p>}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[620px] text-left text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="p-2">Bale Ref</th><th className="p-2">Article</th>
              <th className="p-2">Product</th><th className="p-2 text-right">KG</th>
              <th className="p-2">Scanned by</th><th className="p-2">Date & Time</th>
            </tr>
          </thead>
          <tbody>
            {detail.map(row => <tr key={row.id} className="border-t">
              <td className="p-2 font-mono">{row.referenceNumber}</td>
              <td className="p-2">{row.articleCode || "—"}</td>
              <td className="p-2">{row.productName || "—"}</td>
              <td className="p-2 text-right tabular-nums">{Number(row.weightKg).toLocaleString()}</td>
              <td className="p-2">{row.operatorName || row.operatorUserId}</td>
              <td className="p-2 tabular-nums">{pressingCell(row, "confirmedAt")}</td>
            </tr>)}
            {!detail.length && !report.isLoading &&
              <tr><td colSpan={6} className="p-5 text-center text-muted-foreground">No scanned bales for these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{report.data?.total || 0} scans · Page {filters.page} / {pageCount}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={filters.page <= 1}
            onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>Previous</Button>
          <Button size="sm" variant="outline" disabled={filters.page >= pageCount}
            onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>Next</Button>
        </div>
      </div>
      {canSeeEveryone && (
        <div className="pt-2">
          <Button size="sm" variant="ghost" onClick={() => setShowCorrections(v => !v)}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            {showCorrections ? "Hide corrections" : "Supervisor corrections"}
          </Button>
          {showCorrections && <PressingCorrectionReview companyId={companyId} userId={userId} rows={detail} />}
        </div>
      )}
    </section>
  );
}
