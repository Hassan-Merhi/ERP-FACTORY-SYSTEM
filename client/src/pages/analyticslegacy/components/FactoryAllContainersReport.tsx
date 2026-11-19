/**
 * Full Factory Container Report (incoming, received and offloaded).
 *
 * The factory sales report only covers sold containers. This report reads the
 * existing company-scoped factory container inventory endpoint, so unsold
 * incoming containers also appear and no ERP containers are mixed in.
 */
import { SearchField } from "@/components/ui/search-field";
import { Container as ContainerIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { factoryReportStatus } from "./factoryContainerReportStatus";
import { useFactoryAllContainersReportState, number, goodsAmount } from "./useFactoryAllContainersReportState";

function formatQty(amount: number, maximumFractionDigits = 2): string {
  return amount.toLocaleString("en-US", { maximumFractionDigits });
}

function formatGoods(amount: number, currency: string): string {
  return `${currency} ${formatQty(amount)}`;
}

export function FactoryAllContainersReport() {
  const {
    period,
    setPeriod,
    supplier,
    setSupplier,
    status,
    setStatus,
    search,
    setSearch,
    isLoading,
    isError,
    refetch,
    reportContainers,
    suppliers,
    statuses,
    visible,
    totals,
    groups,
  } = useFactoryAllContainersReportState();

  return (
    <Card className="p-4 md:p-6" data-testid="factory-all-containers-report">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <ContainerIcon className="h-4 w-4" /> All Factory Containers
          </h3>
          <p className="text-xs text-muted-foreground">
            Incoming, received and offloaded containers in the selected factory company
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {visible.length} of {reportContainers.length} containers
        </span>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Period</label>
          <PeriodFilter value={period} onChange={setPeriod} data-testid="factory-container-period-filter" />
        </div>
        <div className="flex min-w-[160px] flex-col gap-1">
          <label className="text-xs text-muted-foreground">Supplier</label>
          <Select value={supplier} onValueChange={setSupplier}>
            <SelectTrigger data-testid="factory-container-supplier-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Suppliers</SelectItem>
              {suppliers.map(([key, name]) => (
                <SelectItem key={key} value={key}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-[150px] flex-col gap-1">
          <label className="text-xs text-muted-foreground">Status</label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger data-testid="factory-container-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {statuses.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <SearchField
          value={search}
          onValueChange={setSearch}
          placeholder="Search containers..."
          wrapperClassName="min-w-[180px] flex-1"
          data-testid="factory-container-search"
        />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">Containers</p>
          <p className="text-xl font-semibold">{visible.length.toLocaleString()}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-xs text-muted-foreground">Total Weight</p>
          <p className="text-xl font-semibold tabular-nums">{formatQty(totals.weight, 3)} kg</p>
        </div>
        <div className="col-span-2 rounded-md border p-3 md:col-span-1">
          <p className="text-xs text-muted-foreground">Goods Value (by Currency)</p>
          {totals.currencies.length ? (
            totals.currencies.map(([ccy, value]) => (
              <p key={ccy} className="text-sm font-semibold tabular-nums">
                {formatGoods(value, ccy)}
              </p>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
        </div>
      </div>
      {totals.estimatedCount > 0 && (
        <p className="mb-4 text-xs text-muted-foreground">
          Some goods values are estimates (weight × rate) where final payable was not entered. Different currencies are
          not combined.
        </p>
      )}
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      ) : isError ? (
        <div className="flex items-center justify-center gap-3 py-8 text-sm text-destructive">
          Could not load factory containers.
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No containers match the selected filters.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Container #</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total KG</TableHead>
                  <TableHead className="text-right">Goods Value</TableHead>
                </TableRow>
              </TableHeader>
              {groups.map(([key, group]) => (
                <TableBody key={key}>
                  {group.rows.map((container) => {
                    const amount = goodsAmount(container);
                    return (
                      <TableRow key={container.id} data-testid={`factory-report-container-${container.id}`}>
                        <TableCell className="font-mono text-xs">{container.containerNumber}</TableCell>
                        <TableCell className="text-sm">{container.supplierName || "No Supplier"}</TableCell>
                        <TableCell className="text-xs">{factoryReportStatus(container.status)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatQty(number(container.totalKg) ?? 0, 3)} kg
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {amount
                            ? `${formatGoods(amount.amount, container.currencyCode || "USD")}${amount.estimated ? " *" : ""}`
                            : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="bg-muted/30 font-medium">
                    <TableCell colSpan={3}>
                      {group.name} — {group.rows.length} containers
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{formatQty(group.weight, 3)} kg</TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              ))}
            </Table>
          </div>
          <div className="space-y-2 md:hidden">
            {visible.map((container) => {
              const amount = goodsAmount(container);
              return (
                <div
                  key={container.id}
                  className="rounded-md border p-3"
                  data-testid={`factory-report-container-mobile-${container.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-mono text-sm font-semibold">{container.containerNumber}</span>
                    <span className="text-xs text-muted-foreground">{factoryReportStatus(container.status)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{container.supplierName || "No Supplier"}</p>
                  <div className="mt-2 flex justify-between gap-2 border-t pt-2 text-xs">
                    <span>{formatQty(number(container.totalKg) ?? 0, 3)} kg</span>
                    <span className="font-mono">
                      {amount
                        ? `${formatGoods(amount.amount, container.currencyCode || "USD")}${amount.estimated ? " *" : ""}`
                        : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
