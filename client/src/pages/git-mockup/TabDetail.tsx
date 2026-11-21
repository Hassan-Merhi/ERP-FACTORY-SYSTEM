import { formatUsd } from "@/lib/moneyDisplay";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/page-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, FileX, CheckCircle2, XCircle, LayoutGrid, List } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtD, parseNum, COMPANY_COLORS, getRealRowBg } from "./helpers";
import { WorkbookLegend, RealWorkbookBlock } from "./WorkbookBlock";
import { SearchField } from "@/components/ui/search-field";
import { useTabDetailState } from "./useTabDetailState";

export function TabDetail() {
  const {
    view,
    setView,
    search,
    setSearch,
    isLoading,
    isError,
    error,
    allContainers,
    filtered,
    totals,
    companies,
    summaryCards,
    modeSelector,
  } = useTabDetailState();

  if (isLoading)
    return (
      <div className="space-y-3">
        {modeSelector}
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32 w-full rounded-md" />
        ))}
      </div>
    );

  if (isError)
    return (
      <div className="space-y-3">
        {modeSelector}
        <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 px-4 py-3 flex gap-3 items-start text-sm text-red-800 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Failed to load container data</div>
            <div className="text-xs mt-0.5">{(error as Error)?.message ?? "Network or server error."}</div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      {modeSelector}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Container tracking summary">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className={cn(
                "flex min-h-24 items-center gap-3 rounded-2xl border p-3 shadow-sm transition-shadow hover:shadow-md sm:p-4",
                card.style
              )}
            >
              <div
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl sm:h-12 sm:w-12",
                  card.iconStyle
                )}
              >
                <Icon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground/75">{card.label}</div>
                <div className="mt-0.5 text-2xl font-bold tracking-tight tabular-nums">
                  {card.value.toLocaleString("en-US")}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {allContainers.length === 0 ? (
        <EmptyState icon={FileX} title="No active containers found" className="rounded-md px-6 py-10" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/80 p-3 shadow-sm">
            <SearchField
              placeholder="Search container, company, truck, agent…"
              wrapperClassName="flex-1 max-w-sm max-sm:basis-full max-sm:max-w-none"
              className="h-9 rounded-lg border-border/70 bg-background/80 shadow-inner shadow-black/5"
              value={search}
              onValueChange={setSearch}
              data-testid="input-git-detail-search"
            />
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
              {filtered.length} rows
            </span>
            <div className="ml-auto flex items-center gap-1 rounded-xl bg-muted/65 p-1">
              <Button
                size="sm"
                variant={view === "workbook" ? "default" : "outline"}
                className={cn(
                  "gap-1.5 rounded-lg text-xs",
                  view === "workbook" &&
                    "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
                )}
                onClick={() => setView("workbook")}
                data-testid="button-view-workbook"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Workbook
              </Button>
              <Button
                size="sm"
                variant={view === "flat" ? "default" : "outline"}
                className={cn(
                  "gap-1.5 rounded-lg text-xs",
                  view === "flat" &&
                    "bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:from-violet-700 hover:to-fuchsia-700"
                )}
                onClick={() => setView("flat")}
                data-testid="button-view-flat"
              >
                <List className="h-3.5 w-3.5" />
                Flat Table
              </Button>
            </div>
          </div>

          {view === "workbook" ? (
            <div className="space-y-4">
              <WorkbookLegend />
              {companies.map((company, idx) => {
                const color = COMPANY_COLORS[idx % COMPANY_COLORS.length];
                return (
                  <RealWorkbookBlock
                    key={company.id}
                    companyName={company.name}
                    rows={company.rows}
                    headerBg={color.bg}
                    headerText={color.text}
                  />
                );
              })}
              {filtered.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-300/40 bg-gradient-to-r from-violet-600 to-indigo-700 px-4 py-3 text-xs font-bold text-white shadow-md shadow-violet-500/10">
                  <span>TOTAL — ALL COMPANIES ({filtered.length} containers)</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span>CTR COST: {formatUsd(totals.amount, 2)}</span>
                    <span>TRANSPORT: {formatUsd(totals.fee, 0)}</span>
                    <span>DUTY: {formatUsd(totals.duty, 0)}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm">
              <Table
                className="text-xs whitespace-nowrap [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide"
                mobileLayout="cards"
              >
                <TableHeader>
                  <TableRow className="bg-muted/70">
                    <TableHead>Container #</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>ETA</TableHead>
                    <TableHead>Truck #</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Border Date</TableHead>
                    <TableHead>Max Offload</TableHead>
                    <TableHead className="text-center">Docs Rcvd</TableHead>
                    <TableHead>Transporter</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Duty</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow
                      key={r.id}
                      className={cn("transition-colors hover:bg-violet-500/10", getRealRowBg(r))}
                      data-testid={`row-git-${r.containerNumber}`}
                    >
                      <TableCell className="font-mono font-semibold">{r.containerNumber}</TableCell>
                      <TableCell className="text-right font-medium">{formatUsd(parseNum(r.grandTotal), 2)}</TableCell>
                      <TableCell>{r.companyName}</TableCell>
                      <TableCell>{fmtD(r.eta)}</TableCell>
                      <TableCell className="font-mono">{r.numberPlate ?? "—"}</TableCell>
                      <TableCell>{r.trackingLocation ?? "—"}</TableCell>
                      <TableCell>{fmtD(r.borderDate)}</TableCell>
                      <TableCell className={cn(r.isOverdue ? "text-red-600 font-bold" : "")}>
                        {fmtD(r.maxOffloadDate)}
                        {r.daysDelayed ? (
                          <span className="ml-1 text-red-600 text-[11px]">+{r.daysDelayed}d</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-center">
                        {r.docReceived ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mx-auto" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-red-500 mx-auto" />
                        )}
                      </TableCell>
                      <TableCell>{r.transporter ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {parseNum(r.transportFee) > 0 ? formatUsd(parseNum(r.transportFee), 0) : "—"}
                      </TableCell>
                      <TableCell>{r.agent ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        {parseNum(r.dutyFee) > 0 ? formatUsd(parseNum(r.dutyFee), 0) : "—"}
                      </TableCell>
                      <TableCell className="max-w-32 truncate text-muted-foreground">
                        {r.trackingDescription ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 font-semibold bg-muted/40">
                    <TableCell className="text-center">Totals ({filtered.length})</TableCell>
                    <TableCell className="text-right">{formatUsd(totals.amount, 2)}</TableCell>
                    <TableCell colSpan={8} />
                    <TableCell className="text-right">{formatUsd(totals.fee, 0)}</TableCell>
                    <TableCell />
                    <TableCell className="text-right">{formatUsd(totals.duty, 0)}</TableCell>
                    <TableCell colSpan={1} />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
