import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt, fmtD, gitContainersUrl, parseNum, getRealRowBg } from "./helpers";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";
import { PORT_BUCKETS as BUCKETS } from "./types";

export function TabPortReport() {
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all" });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const allContainers: EnrichedContainerApi[] = data?.containers ?? [];

  const modeSelector = (
    <div className="max-sm:grid max-sm:grid-cols-2 max-sm:[&>button]:h-auto max-sm:[&>button]:min-w-0 max-sm:[&>button]:whitespace-normal max-sm:[&>button]:py-1.5 flex items-center gap-2 mb-3">
      <span className="max-sm:hidden text-xs text-muted-foreground">Viewing:</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        onClick={() => setCompanyMode("session")}
        data-testid="btn-port-mode-session"
      >
        My Company
      </Button>
      <Button
        size="sm"
        variant={companyMode === "all" ? "default" : "outline"}
        onClick={() => setCompanyMode("all")}
        data-testid="btn-port-mode-all"
      >
        All Accessible Companies
      </Button>
    </div>
  );

  if (isLoading)
    return (
      <div className="space-y-3">
        {modeSelector}
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-md" />
        ))}
      </div>
    );

  if (isError)
    return (
      <div className="space-y-3">
        {modeSelector}
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-semibold">Failed to load container data</div>
            <div className="text-xs mt-0.5">{(error as Error)?.message ?? "Network or server error."}</div>
          </div>
        </div>
      </div>
    );

  const bucketed = BUCKETS.map((b) => ({
    ...b,
    rows: allContainers.filter((r) => b.statuses.includes(r.status)),
  }));

  const totalCount = allContainers.length;
  const totalCost = allContainers.reduce((s, r) => s + parseNum(r.grandTotal), 0);

  return (
    <div className="space-y-4">
      {modeSelector}

      <div className="flex gap-4 flex-wrap p-3 rounded-md border bg-muted/30 text-sm">
        {bucketed.map((b) => (
          <div key={b.key} className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">{b.label}:</span>
            <span className="text-sm font-bold">{b.rows.length}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Total:</span>
          <span className="text-sm font-bold">{totalCount}</span>
        </div>
        {totalCost > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">Total Cost:</span>
            <span className="text-sm font-bold text-green-600">${fmt(totalCost, 0)}</span>
          </div>
        )}
      </div>

      {totalCount === 0 && (
        <div className="py-10 text-center text-muted-foreground text-sm">No active containers found.</div>
      )}

      {bucketed.map((b) => {
        const bucketTotal = b.rows.reduce((s, r) => s + parseNum(r.grandTotal), 0);
        const companies = [...new Set(b.rows.map((r) => r.companyName))];
        return (
          <div key={b.key} className="rounded-md border overflow-hidden">
            <div className={cn("flex items-center justify-between px-3 py-1.5", b.headerBg, b.headerText)}>
              <span className="text-sm font-bold">{b.label}</span>
              <span className="text-xs font-semibold opacity-90">
                {b.rows.length} container{b.rows.length !== 1 ? "s" : ""}
                {bucketTotal > 0 ? ` — $${fmt(bucketTotal, 0)}` : ""}
              </span>
            </div>

            {b.rows.length === 0 ? (
              <div className="py-3 text-center text-xs text-muted-foreground italic bg-muted/10">No containers</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs whitespace-nowrap border-collapse">
                  <thead>
                    <tr className="bg-muted/60 border-b text-muted-foreground">
                      <th className="py-1 px-2 font-semibold text-center">CONTAINER #</th>
                      <th className="py-1 px-2 font-semibold text-center">CO.</th>
                      <th className="py-1 px-2 font-semibold text-center">AMOUNT</th>
                      <th className="py-1 px-2 font-semibold text-center">ETA</th>
                      <th className="py-1 px-2 font-semibold text-center">TRANSPORTER</th>
                      <th className="py-1 px-2 font-semibold text-center">TRUCK #</th>
                      <th className="py-1 px-2 font-semibold text-center">LOCATION</th>
                      <th className="py-1 px-2 font-semibold text-center">BORDER DT.</th>
                      <th className="py-1 px-2 font-semibold text-center">MAX OFFLOAD</th>
                      <th className="py-1 px-2 font-semibold text-center">DOCS RCVD</th>
                      <th className="py-1 px-2 font-semibold text-center">DOCS→TRUCK</th>
                      <th className="py-1 px-2 font-semibold text-center">AGENT</th>
                      <th className="py-1 px-2 font-semibold text-center">NOTES</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companies.map((company) => {
                      const compRows = b.rows.filter((r) => r.companyName === company);
                      return compRows.map((r, idx) => (
                        <tr
                          key={r.id}
                          className={cn(
                            "border-b last:border-b-0 hover:brightness-95",
                            getRealRowBg(r),
                            idx === 0 ? "border-t border-muted/60" : ""
                          )}
                        >
                          <td className="py-0.5 px-2 font-mono font-bold">{r.containerNumber}</td>
                          <td className="py-0.5 px-2 font-medium">{r.companyName}</td>
                          <td className="py-0.5 px-2 text-right font-semibold">
                            {parseNum(r.grandTotal) > 0 ? `$${fmt(parseNum(r.grandTotal), 0)}` : "—"}
                          </td>
                          <td className="py-0.5 px-2">{fmtD(r.eta)}</td>
                          <td className="py-0.5 px-2">{r.transporter ?? "—"}</td>
                          <td className="py-0.5 px-2 font-mono">{r.numberPlate ?? "—"}</td>
                          <td className="py-0.5 px-2">{r.trackingLocation ?? "—"}</td>
                          <td className="py-0.5 px-2">{fmtD(r.borderDate)}</td>
                          <td className={cn("py-0.5 px-2", r.daysDelayed ? "text-red-600 font-bold" : "")}>
                            {fmtD(r.maxOffloadDate)}
                            {r.daysDelayed ? <span className="ml-1 text-[10px]">+{r.daysDelayed}d</span> : null}
                          </td>
                          <td className="py-0.5 px-2 text-center">
                            {r.docReceived ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mx-auto" />
                            ) : (
                              <XCircle className="h-3.5 w-3.5 text-red-500 mx-auto" />
                            )}
                          </td>
                          <td className="py-0.5 px-2 text-center">
                            {r.docsSentDate ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mx-auto" />
                            ) : r.docReceived ? (
                              <span className="text-amber-700 text-[10px] font-medium">READY</span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="py-0.5 px-2">{r.agent ?? "—"}</td>
                          <td className="py-0.5 px-2 max-w-40 truncate text-muted-foreground italic">
                            {r.trackingDescription ?? "—"}
                          </td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
