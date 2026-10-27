import { Fragment } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PeriodFilter } from "@/components/ui/period-filter";
import { ChevronDown, Container as ContainerIcon, Check, Info } from "lucide-react";

import type { ReportContainer } from "../types";
import { FactoryAllContainersReport } from "./FactoryAllContainersReport";

import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";

function ContainerCostBreakdown({
  container,
  formatAmount,
}: {
  container: ReportContainer;
  formatAmount: (value: number) => string;
}) {
  const money = (value: string) => formatAmount(parseFloat(value || "0"));
  const breakdown = container.chargeBreakdown;
  const lines = [
    ["Goods cost", container.itemsTotal],
    ["Purchase charges (freight, documents, etc.)", container.chargesTotal],
    ["Purchase grand total", container.grandTotal],
    ["Duties", breakdown.duties],
    ["Office charges", breakdown.officeCharges],
    ["Transport fees", breakdown.transportFees],
    ["Transfer charges", breakdown.transferCharges],
    ["Other offloading charges", breakdown.additionalCharges],
    ["Offloading & extras total", container.offloadingCharges],
  ] as const;
  return (
    <div className="space-y-2 text-sm">
      <div className="font-semibold">Container {container.containerNumber} — cost breakdown</div>
      <div className="space-y-1">
        {lines.map(([label, amount], index) => (
          <div
            key={label}
            className={`flex items-start justify-between gap-4 ${index === 2 || index === 8 ? "border-t pt-1 font-semibold" : ""}`}
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="shrink-0 font-mono tabular-nums">{money(amount)}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between gap-4 border-t-2 pt-2 font-bold">
        <span>Total container cost</span>
        <span className="font-mono tabular-nums">{money(container.totalContainerCost)}</span>
      </div>
    </div>
  );
}

function CostBreakdownButton({
  container,
  formatAmount,
}: {
  container: ReportContainer;
  formatAmount: (value: number) => string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`View cost breakdown for container ${container.containerNumber}`}
          className="inline-flex items-center gap-1.5 font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          <span>{formatAmount(parseFloat(container.totalContainerCost || "0"))}</span>
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,350px)]">
        <ContainerCostBreakdown container={container} formatAmount={formatAmount} />
      </PopoverContent>
    </Popover>
  );
}

export function ContainersSectionPanel({ analytics }: { analytics: AnalyticsLegacyState }) {
  const {
    activeSection,
    appMode,
    containerData,
    containerPeriodFilter,
    formatAmount,
    loadingContainers,
    reportAllCompanies,
    reportContainerStatus,
    reportSupplierIds,
    setContainerPeriodFilter,
    setReportAllCompanies,
    setReportContainerStatus,
    setReportSupplierIds,
    userCompanies,
  } = analytics;
  return (
    <>
      {activeSection === "containers" && appMode === "factory" && <FactoryAllContainersReport />}

      {activeSection === "containers" && appMode !== "factory" && (
        <Card className="p-6">
          <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ContainerIcon className="h-4 w-4" />
              </div>
              <h3 className="font-semibold text-base">Container Report</h3>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 mb-6 items-end">
            <div className="flex flex-col gap-1.5">
              <Label>Period</Label>
              <PeriodFilter
                value={containerPeriodFilter}
                onChange={setContainerPeriodFilter}
                data-testid="container-report-period-filter"
              />
            </div>
            <div className="flex flex-col gap-1.5 min-w-[160px]">
              <Label>Supplier</Label>
              {(() => {
                const supplierOptions = Array.from(
                  new Map(
                    (containerData?.containers ?? []).map((c) => [
                      c.supplierId,
                      { id: c.supplierId, name: c.supplierName },
                    ])
                  ).values()
                ).sort((a, b) => a.name.localeCompare(b.name));
                const label =
                  reportSupplierIds.length === 0
                    ? "All Suppliers"
                    : reportSupplierIds.length === 1
                      ? (supplierOptions.find((s) => s.id === reportSupplierIds[0])?.name ?? "1 supplier")
                      : `${reportSupplierIds.length} suppliers`;
                return (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="min-w-[160px] justify-between font-normal">
                        <span className="truncate">{label}</span>
                        <ChevronDown className="h-4 w-4 ml-2 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-2 max-h-72 overflow-y-auto" align="start">
                      <button
                        type="button"
                        aria-pressed={reportSupplierIds.length === 0}
                        className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-sm hover:bg-accent"
                        onClick={() => setReportSupplierIds([])}
                      >
                        <Check className={`h-4 w-4 ${reportSupplierIds.length === 0 ? "opacity-100" : "opacity-0"}`} />
                        All Suppliers
                      </button>
                      <div className="border-t my-1" />
                      {supplierOptions.map((supplier) => (
                        <button
                          key={supplier.id}
                          type="button"
                          aria-pressed={reportSupplierIds.includes(supplier.id)}
                          className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded-sm hover:bg-accent"
                          onClick={() =>
                            setReportSupplierIds((prev) =>
                              prev.includes(supplier.id)
                                ? prev.filter((id) => id !== supplier.id)
                                : [...prev, supplier.id]
                            )
                          }
                        >
                          <Check
                            className={`h-4 w-4 shrink-0 ${reportSupplierIds.includes(supplier.id) ? "opacity-100" : "opacity-0"}`}
                          />
                          <span className="truncate">{supplier.name}</span>
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                );
              })()}
            </div>
            <div className="flex flex-col gap-1.5 min-w-[140px]">
              <Label htmlFor="container-status">Status</Label>
              <Select value={reportContainerStatus} onValueChange={setReportContainerStatus}>
                <SelectTrigger id="container-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Offloaded">Offloaded</SelectItem>
                  <SelectItem value="OTW">OTW</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5 min-w-[160px]">
              <Label htmlFor="container-company">Company</Label>
              <Select value={reportAllCompanies} onValueChange={setReportAllCompanies}>
                <SelectTrigger id="container-company">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Companies</SelectItem>
                  {userCompanies.map((c) => (
                    <SelectItem key={c.companyId} value={String(c.companyId)}>
                      {c.companyName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {loadingContainers ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : containerData ? (
            (() => {
              const isAllCompanies = reportAllCompanies === "all";
              const dateCol = reportContainerStatus === "Offloaded" ? "Offload Date" : "Import Date";
              const getDate = (c: ReportContainer) =>
                reportContainerStatus === "Offloaded" ? c.offloadDate || "-" : c.importDate || "-";

              // Client-side supplier filter
              const visibleContainers =
                reportSupplierIds.length === 0
                  ? containerData.containers
                  : containerData.containers.filter((c) => reportSupplierIds.includes(c.supplierId));

              // Group by supplierId, sorted alphabetically; within each group sort by date DESC
              const supplierMap = new Map<
                number,
                {
                  supplierId: number;
                  supplierName: string;
                  containers: ReportContainer[];
                  grandTotal: number;
                  offloadingCharges: number;
                  totalContainerCost: number;
                }
              >();
              for (const c of visibleContainers) {
                if (!supplierMap.has(c.supplierId)) {
                  supplierMap.set(c.supplierId, {
                    supplierId: c.supplierId,
                    supplierName: c.supplierName,
                    containers: [],
                    grandTotal: 0,
                    offloadingCharges: 0,
                    totalContainerCost: 0,
                  });
                }
                const g = supplierMap.get(c.supplierId)!;
                g.containers.push(c);
                g.grandTotal += parseFloat(c.grandTotal || "0");
                g.offloadingCharges += parseFloat(c.offloadingCharges || "0");
                g.totalContainerCost += parseFloat(c.totalContainerCost || "0");
              }
              const supplierGroups = Array.from(supplierMap.values()).sort((a, b) =>
                a.supplierName.localeCompare(b.supplierName)
              );
              for (const g of supplierGroups) {
                g.containers.sort((a, b) => getDate(b).localeCompare(getDate(a)));
              }
              const visibleGrandTotal = visibleContainers.reduce((s, c) => s + parseFloat(c.grandTotal || "0"), 0);
              const visibleOffloadingCharges = visibleContainers.reduce((s, c) => s + parseFloat(c.offloadingCharges || "0"), 0);
              const visibleTotalCost = visibleContainers.reduce((s, c) => s + parseFloat(c.totalContainerCost || "0"), 0);
              const colSpan = isAllCompanies ? 8 : 7;

              return (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-3" data-testid="container-report-cost-summary">
                    <div className="rounded-lg border p-3">
                      <div className="text-xs text-muted-foreground">Purchase Grand Total</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums">{formatAmount(visibleGrandTotal)}</div>
                    </div>
                    <div className="rounded-lg border p-3">
                      <div className="text-xs text-muted-foreground">Offloading & Extra Charges</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums">{formatAmount(visibleOffloadingCharges)}</div>
                    </div>
                    <div className="rounded-lg border bg-muted/30 p-3">
                      <div className="text-xs text-muted-foreground">Total Container Cost ({visibleContainers.length})</div>
                      <div className="mt-1 text-lg font-bold tabular-nums">{formatAmount(visibleTotalCost)}</div>
                    </div>
                  </div>
                  <div className="hidden md:block overflow-x-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Container #</TableHead>
                          <TableHead>Supplier</TableHead>
                          {isAllCompanies && <TableHead>Company</TableHead>}
                          <TableHead>Status</TableHead>
                          <TableHead>{dateCol}</TableHead>
                          <TableHead className="text-right">Grand Total</TableHead>
                          <TableHead className="text-right">Offloading & Extras</TableHead>
                          <TableHead className="text-right">Total Container Cost</TableHead>
                        </TableRow>
                      </TableHeader>
                      {supplierGroups.map((sg) => (
                        <Fragment key={sg.supplierId}>
                          <TableBody>
                            {sg.containers.map((container) => (
                              <TableRow key={container.id}>
                                <TableCell className="font-mono text-sm">{container.containerNumber}</TableCell>
                                <TableCell className="text-sm">{container.supplierName}</TableCell>
                                {isAllCompanies && <TableCell className="text-sm">{container.companyName}</TableCell>}
                                <TableCell className="text-sm">{container.status}</TableCell>
                                <TableCell className="text-sm">{getDate(container)}</TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  {formatAmount(parseFloat(container.grandTotal || "0"))}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  {formatAmount(parseFloat(container.offloadingCharges || "0"))}
                                </TableCell>
                                <TableCell className="text-right font-mono text-sm">
                                  <CostBreakdownButton container={container} formatAmount={formatAmount} />
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                          <TableBody>
                            <TableRow className="bg-muted/40 font-semibold">
                              <TableCell colSpan={colSpan - 3} className="text-sm">
                                {sg.supplierName} — {sg.containers.length} container
                                {sg.containers.length !== 1 ? "s" : ""}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatAmount(sg.grandTotal)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatAmount(sg.offloadingCharges)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatAmount(sg.totalContainerCost)}</TableCell>
                            </TableRow>
                          </TableBody>
                        </Fragment>
                      ))}
                      <TableBody>
                        <TableRow className="font-bold border-t-2">
                          <TableCell colSpan={colSpan - 3}>TOTALS ({visibleContainers.length} containers)</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(visibleGrandTotal)}</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(visibleOffloadingCharges)}</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(visibleTotalCost)}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                  <div className="md:hidden space-y-3">
                    {supplierGroups.map((sg) => (
                      <div key={sg.supplierId} className="space-y-2">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
                          {sg.supplierName}
                        </div>
                        {sg.containers.map((container) => (
                          <Card key={container.id}>
                            <CardContent className="p-4 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono font-medium">{container.containerNumber}</span>
                                <span className="text-sm text-muted-foreground">{container.status}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2 text-sm">
                                <span className="text-muted-foreground">
                                  {isAllCompanies ? `${container.companyName} · ` : ""}
                                  {getDate(container)}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-2 text-sm">
                                <span className="text-muted-foreground">Purchase Grand Total</span>
                                <span className="font-mono">{formatAmount(parseFloat(container.grandTotal || "0"))}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2 text-sm">
                                <span className="text-muted-foreground">Offloading & Extras</span>
                                <span className="font-mono">{formatAmount(parseFloat(container.offloadingCharges || "0"))}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2 border-t pt-2 text-sm">
                                <span className="font-semibold">Total Container Cost</span>
                                <span className="font-mono">
                                  <CostBreakdownButton container={container} formatAmount={formatAmount} />
                                </span>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                        <Card className="bg-muted/40">
                          <CardContent className="p-3 space-y-2">
                            <span className="text-sm font-semibold">{sg.supplierName} ({sg.containers.length})</span>
                            <div className="flex justify-between text-xs gap-2">
                              <span>Grand Total</span>
                              <span className="font-mono">{formatAmount(sg.grandTotal)}</span>
                            </div>
                            <div className="flex justify-between text-xs gap-2">
                              <span>Offloading & Extras</span>
                              <span className="font-mono">{formatAmount(sg.offloadingCharges)}</span>
                            </div>
                            <div className="flex justify-between border-t pt-2 text-sm font-semibold gap-2">
                              <span>Total Container Cost</span>
                              <span className="font-mono">{formatAmount(sg.totalContainerCost)}</span>
                            </div>
                          </CardContent>
                        </Card>
                      </div>
                    ))}
                    <Card className="bg-muted/50">
                      <CardContent className="p-4 space-y-2">
                        <div className="font-bold text-sm">TOTALS ({visibleContainers.length} containers)</div>
                        <div className="flex justify-between text-sm gap-2">
                          <span>Grand Total</span>
                          <span className="font-mono">{formatAmount(visibleGrandTotal)}</span>
                        </div>
                        <div className="flex justify-between text-sm gap-2">
                          <span>Offloading & Extras</span>
                          <span className="font-mono">{formatAmount(visibleOffloadingCharges)}</span>
                        </div>
                        <div className="flex justify-between border-t pt-2 font-bold gap-2">
                          <span>Total Container Cost</span>
                          <span className="font-mono">{formatAmount(visibleTotalCost)}</span>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-14 text-muted-foreground">
              <ContainerIcon className="h-10 w-10 opacity-25" />
              <p className="text-sm font-medium">No data yet</p>
              <p className="text-xs opacity-60">Adjust the filters above to load the report</p>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
