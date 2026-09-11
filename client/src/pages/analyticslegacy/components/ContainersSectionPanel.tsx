import { Fragment } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { PeriodFilter } from "@/components/ui/period-filter";
import { ChevronDown, Container as ContainerIcon, Check } from "lucide-react";

import type { ReportContainer } from "../types";

import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";

export function ContainersSectionPanel({ analytics }: { analytics: AnalyticsLegacyState }) {
  const {
    activeSection,
    appMode,
    containerData,
    containerPeriodFilter,
    factoryContainerCustomerId,
    factoryContainerEndDate,
    factoryContainerPaymentStatus,
    factoryContainerSales,
    factoryContainerStartDate,
    factorySalesByCustomer,
    formatAmount,
    loadingContainers,
    loadingFactoryContainerSales,
    reportAllCompanies,
    reportContainerStatus,
    reportSupplierIds,
    setContainerPeriodFilter,
    setFactoryContainerCustomerId,
    setFactoryContainerEndDate,
    setFactoryContainerPaymentStatus,
    setFactoryContainerStartDate,
    setReportAllCompanies,
    setReportContainerStatus,
    setReportSupplierIds,
    userCompanies,
  } = analytics;
  return (
    <>
      {activeSection === "containers" && appMode === "factory" && (
        <Card className="p-6">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <h3 className="text-lg font-medium flex items-center gap-2">
              <ContainerIcon className="h-5 w-5" />
              Container Report
            </h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div>
              <Label>Start Date</Label>
              <DatePickerInput
                value={factoryContainerStartDate}
                onChange={setFactoryContainerStartDate}
                placeholder="Start date"
              />
            </div>
            <div>
              <Label>End Date</Label>
              <DatePickerInput
                value={factoryContainerEndDate}
                onChange={setFactoryContainerEndDate}
                placeholder="End date"
              />
            </div>
            <div>
              <Label>Customer</Label>
              <Select value={factoryContainerCustomerId} onValueChange={setFactoryContainerCustomerId}>
                <SelectTrigger>
                  <SelectValue placeholder="All Customers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Customers</SelectItem>
                  {factorySalesByCustomer.map((r) => (
                    <SelectItem key={r.customerId} value={String(r.customerId ?? "")}>
                      {r.customerName || `Customer #${r.customerId}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Payment Status</Label>
              <Select value={factoryContainerPaymentStatus} onValueChange={setFactoryContainerPaymentStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="PARTIAL">Partial</SelectItem>
                  <SelectItem value="PAID">Paid</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {loadingFactoryContainerSales ? (
            <div className="text-center py-8 text-muted-foreground">Loading...</div>
          ) : factoryContainerSales ? (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Containers</div>
                  <div className="text-xl font-bold">{factoryContainerSales.summary.count}</div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Total Value</div>
                  <div className="text-xl font-bold font-mono">{formatAmount(factoryContainerSales.summary.total)}</div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Paid</div>
                  <div className="text-xl font-bold font-mono text-green-600 dark:text-green-400">
                    {formatAmount(factoryContainerSales.summary.paid)}
                  </div>
                </div>
                <div className="border rounded-md p-3">
                  <div className="text-xs text-muted-foreground">Outstanding</div>
                  <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400">
                    {formatAmount(factoryContainerSales.summary.outstanding)}
                  </div>
                </div>
              </div>

              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Container #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Sale Date</TableHead>
                      <TableHead>Container Status</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {factoryContainerSales.rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-mono">{row.containerNumber || "-"}</TableCell>
                        <TableCell className="font-medium">{row.customerName || `#${row.customerId}`}</TableCell>
                        <TableCell className="font-mono text-sm">{row.invoiceNumber || "-"}</TableCell>
                        <TableCell>{row.saleDate}</TableCell>
                        <TableCell>
                          <span
                            className={`text-xs font-medium px-2 py-0.5 rounded-full border ${row.containerStatus === "OFFLOADED" ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-950 dark:border-green-800 dark:text-green-300" : "bg-muted border-muted-foreground/20 text-muted-foreground"}`}
                          >
                            {row.containerStatus || "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`text-xs font-medium px-2 py-0.5 rounded-full border ${row.paymentStatus === "PAID" ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-950 dark:border-green-800 dark:text-green-300" : row.paymentStatus === "PARTIAL" ? "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-300" : "bg-muted border-muted-foreground/20 text-muted-foreground"}`}
                          >
                            {row.paymentStatus}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatAmount(parseFloat(row.totalAmount))}
                        </TableCell>
                        <TableCell className="text-right font-mono text-green-600 dark:text-green-400">
                          {formatAmount(parseFloat(row.paidAmount))}
                        </TableCell>
                        <TableCell className="text-right font-mono text-amber-600 dark:text-amber-400">
                          {formatAmount(parseFloat(row.totalAmount) - parseFloat(row.paidAmount))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="md:hidden space-y-3">
                {factoryContainerSales.rows.map((row) => (
                  <Card key={row.id}>
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium">{row.containerNumber || "-"}</span>
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full border ${row.paymentStatus === "PAID" ? "bg-green-50 border-green-200 text-green-700 dark:bg-green-950 dark:border-green-800 dark:text-green-300" : row.paymentStatus === "PARTIAL" ? "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-300" : "bg-muted border-muted-foreground/20 text-muted-foreground"}`}
                        >
                          {row.paymentStatus}
                        </span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {row.customerName} · {row.saleDate}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs pt-1 border-t">
                        <div>
                          <span className="text-muted-foreground block">Total</span>
                          <span className="font-mono">{formatAmount(parseFloat(row.totalAmount))}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground block">Paid</span>
                          <span className="font-mono text-green-600 dark:text-green-400">
                            {formatAmount(parseFloat(row.paidAmount))}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-muted-foreground block">Outstanding</span>
                          <span className="font-mono text-amber-600 dark:text-amber-400">
                            {formatAmount(parseFloat(row.totalAmount) - parseFloat(row.paidAmount))}
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-14 text-muted-foreground">
              <ContainerIcon className="h-10 w-10 opacity-25" />
              <p className="text-sm font-medium">No data yet</p>
              <p className="text-xs opacity-60">Adjust the filters above to load the report</p>
            </div>
          )}
        </Card>
      )}

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
                        className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent"
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
                          className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent"
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
                { supplierId: number; supplierName: string; containers: ReportContainer[]; total: number }
              >();
              for (const c of visibleContainers) {
                if (!supplierMap.has(c.supplierId)) {
                  supplierMap.set(c.supplierId, {
                    supplierId: c.supplierId,
                    supplierName: c.supplierName,
                    containers: [],
                    total: 0,
                  });
                }
                const g = supplierMap.get(c.supplierId)!;
                g.containers.push(c);
                g.total += parseFloat(c.grandTotal || "0");
              }
              const supplierGroups = Array.from(supplierMap.values()).sort((a, b) =>
                a.supplierName.localeCompare(b.supplierName)
              );
              for (const g of supplierGroups) {
                g.containers.sort((a, b) => getDate(b).localeCompare(getDate(a)));
              }
              const visibleTotal = visibleContainers.reduce((s, c) => s + parseFloat(c.grandTotal || "0"), 0);
              const colSpan = isAllCompanies ? 6 : 5;

              return (
                <div className="space-y-4">
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
                                  {formatAmount(parseFloat(container.grandTotal))}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                          <TableBody>
                            <TableRow className="bg-muted/40 font-semibold">
                              <TableCell colSpan={colSpan - 1} className="text-sm">
                                {sg.supplierName} — {sg.containers.length} container
                                {sg.containers.length !== 1 ? "s" : ""}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">{formatAmount(sg.total)}</TableCell>
                            </TableRow>
                          </TableBody>
                        </Fragment>
                      ))}
                      <TableBody>
                        <TableRow className="font-bold border-t-2">
                          <TableCell colSpan={colSpan - 1}>TOTALS ({visibleContainers.length} containers)</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(visibleTotal)}</TableCell>
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
                                <span className="font-mono font-semibold">
                                  {formatAmount(parseFloat(container.grandTotal))}
                                </span>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                        <Card className="bg-muted/40">
                          <CardContent className="p-3 flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">
                              {sg.supplierName} ({sg.containers.length})
                            </span>
                            <span className="font-mono font-semibold text-sm">{formatAmount(sg.total)}</span>
                          </CardContent>
                        </Card>
                      </div>
                    ))}
                    <Card className="bg-muted/50">
                      <CardContent className="p-4 flex items-center justify-between gap-2">
                        <span className="font-bold text-sm">TOTALS ({visibleContainers.length} containers)</span>
                        <span className="font-mono font-semibold">{formatAmount(visibleTotal)}</span>
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
