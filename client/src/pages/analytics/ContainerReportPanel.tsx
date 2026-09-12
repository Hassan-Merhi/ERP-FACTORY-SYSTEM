import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PeriodFilter, PeriodFilterValue } from "@/components/ui/period-filter";
import { Container as ContainerIcon } from "lucide-react";
import { ReportContainer, ContainerData, Supplier } from "./analyticsTypes";

interface FactoryContainerSalesRow {
  id: number;
  containerNumber?: string;
  customerName?: string;
  customerId?: number;
  invoiceNumber?: string;
  saleDate?: string;
  containerStatus?: string;
  paymentStatus?: string;
  totalAmount: string;
  paidAmount: string;
}

interface FactoryContainerSales {
  summary: { count: number; total: number; paid: number; outstanding: number };
  rows: FactoryContainerSalesRow[];
}

interface UserCompanyOption {
  companyId: number;
  companyName: string;
}

interface ContainerReportPanelProps {
  appMode: string;
  factoryContainerSales: FactoryContainerSales | undefined;
  loadingFactoryContainerSales: boolean;
  formatAmount: (amount: number) => string;
  containerPeriodFilter: PeriodFilterValue;
  setContainerPeriodFilter: (filter: PeriodFilterValue) => void;
  reportSupplierId: string;
  setReportSupplierId: (id: string) => void;
  suppliers: Supplier[];
  reportContainerStatus: string;
  setReportContainerStatus: (status: string) => void;
  reportAllCompanies: string;
  setReportAllCompanies: (id: string) => void;
  userCompanies: UserCompanyOption[];
  loadingContainers: boolean;
  containerData?: ContainerData;
}

export function ContainerReportPanel({
  appMode,
  factoryContainerSales,
  loadingFactoryContainerSales,
  formatAmount,
  containerPeriodFilter,
  setContainerPeriodFilter,
  reportSupplierId,
  setReportSupplierId,
  suppliers,
  reportContainerStatus,
  setReportContainerStatus,
  reportAllCompanies,
  setReportAllCompanies,
  userCompanies,
  loadingContainers,
  containerData,
}: ContainerReportPanelProps) {
  if (appMode === "factory") {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <ContainerIcon className="h-4 w-4" />
            </div>
            <h3 className="font-semibold text-base">Factory Container Report</h3>
          </div>
        </div>

        {loadingFactoryContainerSales ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : factoryContainerSales ? (
          <div className="space-y-4">
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
    );
  }

  return (
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
          <Label htmlFor="container-supplier">Supplier</Label>
          <Select value={reportSupplierId} onValueChange={setReportSupplierId}>
            <SelectTrigger id="container-supplier">
              <SelectValue placeholder="All Suppliers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Suppliers</SelectItem>
              {suppliers.map((supplier) => (
                <SelectItem key={supplier.id} value={supplier.id.toString()}>
                  {supplier.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

          const companyGroups: {
            companyId: number;
            companyName: string;
            containers: ReportContainer[];
            total: number;
          }[] = [];
          if (isAllCompanies) {
            const map = new Map<number, (typeof companyGroups)[0]>();
            for (const c of containerData.containers) {
              if (!map.has(c.companyId)) {
                map.set(c.companyId, { companyId: c.companyId, companyName: c.companyName, containers: [], total: 0 });
              }
              const g = map.get(c.companyId)!;
              g.containers.push(c);
              g.total += parseFloat(c.grandTotal || "0");
            }
            companyGroups.push(...Array.from(map.values()).sort((a, b) => a.companyName.localeCompare(b.companyName)));
          }

          const colSpanTotal = isAllCompanies ? 6 : 5;

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
                  {isAllCompanies ? (
                    <>
                      {companyGroups.map((group) => (
                        <TableBody key={group.companyId}>
                          {group.containers.map((container) => (
                            <TableRow key={container.id}>
                              <TableCell className="font-mono text-sm">{container.containerNumber}</TableCell>
                              <TableCell className="text-sm">{container.supplierName}</TableCell>
                              <TableCell className="text-sm">{container.companyName}</TableCell>
                              <TableCell className="text-sm">{container.status}</TableCell>
                              <TableCell className="text-sm">{getDate(container)}</TableCell>
                              <TableCell className="text-right font-mono text-sm">
                                {formatAmount(parseFloat(container.grandTotal))}
                              </TableCell>
                            </TableRow>
                          ))}
                          <TableRow className="bg-muted/50 font-semibold">
                            <TableCell colSpan={colSpanTotal - 1} className="text-sm">
                              {group.companyName} — {group.containers.length} container
                              {group.containers.length !== 1 ? "s" : ""}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">{formatAmount(group.total)}</TableCell>
                          </TableRow>
                        </TableBody>
                      ))}
                      <TableBody>
                        <TableRow className="font-bold border-t-2">
                          <TableCell colSpan={colSpanTotal - 1}>
                            TOTALS ({containerData.summary.totalContainers} containers)
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatAmount(containerData.summary.totalGrandTotal)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </>
                  ) : (
                    <>
                      <TableBody>
                        {containerData.containers.map((container) => (
                          <TableRow key={container.id}>
                            <TableCell className="font-mono">{container.containerNumber}</TableCell>
                            <TableCell>{container.supplierName}</TableCell>
                            <TableCell>{container.status}</TableCell>
                            <TableCell>{getDate(container)}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatAmount(parseFloat(container.grandTotal))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                      <TableBody className="font-semibold border-t-2">
                        <TableRow>
                          <TableCell colSpan={3}>TOTALS ({containerData.summary.totalContainers} containers)</TableCell>
                          <TableCell></TableCell>
                          <TableCell className="text-right font-mono">
                            {formatAmount(containerData.summary.totalGrandTotal)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </>
                  )}
                </Table>
              </div>
              <div className="md:hidden space-y-3">
                {isAllCompanies
                  ? companyGroups.map((group) => (
                      <div key={group.companyId} className="space-y-2">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
                          {group.companyName}
                        </div>
                        {group.containers.map((container) => (
                          <Card key={container.id}>
                            <CardContent className="p-4 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono font-medium">{container.containerNumber}</span>
                                <span className="text-sm text-muted-foreground">{container.status}</span>
                              </div>
                              <div className="flex items-center justify-between gap-2 text-sm">
                                <span className="text-muted-foreground">
                                  {container.supplierName} · {getDate(container)}
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
                              {group.companyName} Total ({group.containers.length})
                            </span>
                            <span className="font-mono font-semibold text-sm">{formatAmount(group.total)}</span>
                          </CardContent>
                        </Card>
                      </div>
                    ))
                  : containerData.containers.map((container) => (
                      <Card key={container.id}>
                        <CardContent className="p-4 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-medium">{container.containerNumber}</span>
                            <span className="text-sm text-muted-foreground">{container.status}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2 text-sm">
                            <span className="text-muted-foreground">
                              {container.supplierName} · {getDate(container)}
                            </span>
                            <span className="font-mono font-semibold">
                              {formatAmount(parseFloat(container.grandTotal))}
                            </span>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                <Card className="bg-muted/50">
                  <CardContent className="p-4 flex items-center justify-between gap-2">
                    <span className="font-bold text-sm">
                      TOTALS ({containerData.summary.totalContainers} containers)
                    </span>
                    <span className="font-mono font-semibold">
                      {formatAmount(containerData.summary.totalGrandTotal)}
                    </span>
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
  );
}
