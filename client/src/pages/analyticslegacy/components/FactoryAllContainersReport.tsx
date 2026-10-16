/**
 * Full Factory Container Report (incoming, received and offloaded).
 *
 * The factory sales report only covers sold containers. This report reads the
 * existing company-scoped factory container inventory endpoint, so unsold
 * incoming containers also appear and no ERP containers are mixed in.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Container as ContainerIcon, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PeriodFilter, getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { factoryReportStatus, isFactoryReportContainer } from "./factoryContainerReportStatus";

type ContainerRow = {
  id: number;
  companyId: number;
  containerNumber: string;
  supplierId: number | null;
  supplierName: string | null;
  status: string;
  origin: string | null;
  arrivalDate: string | null;
  createdAt: string;
  totalKg: string | null;
  actualReceivedKg: string | null;
  ratePerKg: string | null;
  finalPayableAmount: string | null;
  currencyCode: string | null;
};

const number = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function goodsAmount(container: ContainerRow): { amount: number; estimated: boolean } | null {
  const finalAmount = number(container.finalPayableAmount);
  if (finalAmount !== null) return { amount: finalAmount, estimated: false };
  const kg = number(container.totalKg);
  const rate = number(container.ratePerKg);
  if (kg === null || rate === null) return null;
  return { amount: kg * rate, estimated: true };
}

function dateValue(container: ContainerRow): string {
  // Arrival is the business date for incoming factory containers. Records without
  // an arrival date use their creation date rather than silently disappearing.
  return container.arrivalDate?.slice(0, 10) || container.createdAt?.slice(0, 10) || "";
}

function formatQty(amount: number, maximumFractionDigits = 2): string {
  return amount.toLocaleString("en-US", { maximumFractionDigits });
}

function formatGoods(amount: number, currency: string): string {
  return `${currency} ${formatQty(amount)}`;
}

export function FactoryAllContainersReport() {
  const [period, setPeriod] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("all_time"));
  const [supplier, setSupplier] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");

  const { data: containers = [], isLoading, isError, refetch } = useQuery<ContainerRow[]>({
    queryKey: ["/api/factory/containers"],
    queryFn: async () => {
      const response = await fetch("/api/factory/containers", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load factory containers");
      return response.json() as Promise<ContainerRow[]>;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // Exclude synthetic opening-balance container records from this report
  // entirely, including the supplier/status filters and total denominator.
  const reportContainers = useMemo(
    () => containers.filter((container) => isFactoryReportContainer(container.status)),
    [containers]
  );

  const suppliers = useMemo(
    () =>
      Array.from(
        new Map(reportContainers.map((c) => [String(c.supplierId ?? "none"), c.supplierName || "No Supplier"])).entries()
      ).sort((a, b) => a[1].localeCompare(b[1])),
    [reportContainers]
  );

  // Group report labels only; keep their original warehouse lifecycle statuses.
  const statuses = useMemo(
    () => [...new Set(reportContainers.map((c) => factoryReportStatus(c.status)))].sort(),
    [reportContainers]
  );

  const visible = useMemo(() => {
    const searchText = search.trim().toLowerCase();
    return reportContainers
      .filter((c) => {
        if (supplier !== "all" && String(c.supplierId ?? "none") !== supplier) return false;
        if (status !== "all" && factoryReportStatus(c.status) !== status) return false;
        const date = dateValue(c);
        if (period.fromDate && (!date || date < period.fromDate)) return false;
        if (period.toDate && (!date || date > period.toDate)) return false;
        if (
          searchText &&
          ![c.containerNumber, c.supplierName, c.origin, factoryReportStatus(c.status)].some((v) => String(v || "").toLowerCase().includes(searchText))
        ) return false;
        return true;
      })
      .sort((a, b) => dateValue(b).localeCompare(dateValue(a)) || b.id - a.id);
  }, [reportContainers, supplier, status, search, period.fromDate, period.toDate]);

  const totals = useMemo(() => {
    const currencies = new Map<string, number>();
    let weight = 0;
    let receivedWeight = 0;
    let estimatedCount = 0;
    for (const c of visible) {
      weight += number(c.totalKg) ?? 0;
      receivedWeight += number(c.actualReceivedKg) ?? 0;
      const value = goodsAmount(c);
      if (!value) continue;
      if (value.estimated) estimatedCount++;
      const currency = c.currencyCode || "USD";
      currencies.set(currency, (currencies.get(currency) || 0) + value.amount);
    }
    return { weight, receivedWeight, estimatedCount, currencies: Array.from(currencies.entries()).sort() };
  }, [visible]);

  const groups = useMemo(() => {
    const bySupplier = new Map<string, { name: string; rows: ContainerRow[]; weight: number }>();
    for (const container of visible) {
      const key = String(container.supplierId ?? "none");
      const group = bySupplier.get(key) ?? {
        name: container.supplierName || "No Supplier",
        rows: [],
        weight: 0,
      };
      group.rows.push(container);
      group.weight += number(container.totalKg) ?? 0;
      bySupplier.set(key, group);
    }
    return [...bySupplier.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [visible]);

  return (
    <Card className="p-4 md:p-6" data-testid="factory-all-containers-report">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <ContainerIcon className="h-4 w-4" /> All Factory Containers
          </h3>
          <p className="text-xs text-muted-foreground">Incoming, received and offloaded containers in the selected factory company</p>
        </div>
        <span className="text-xs text-muted-foreground">{visible.length} of {reportContainers.length} containers</span>
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Period</label>
          <PeriodFilter value={period} onChange={setPeriod} data-testid="factory-container-period-filter" />
        </div>
        <div className="flex min-w-[160px] flex-col gap-1">
          <label className="text-xs text-muted-foreground">Supplier</label>
          <Select value={supplier} onValueChange={setSupplier}>
            <SelectTrigger data-testid="factory-container-supplier-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Suppliers</SelectItem>
              {suppliers.map(([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-[150px] flex-col gap-1">
          <label className="text-xs text-muted-foreground">Status</label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger data-testid="factory-container-status-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {statuses.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search containers..." className="pl-8" data-testid="factory-container-search" />
        </div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Containers</p><p className="text-xl font-semibold">{visible.length.toLocaleString()}</p></div>
        <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Total Weight</p><p className="text-xl font-semibold tabular-nums">{formatQty(totals.weight, 3)} kg</p></div>
        <div className="col-span-2 rounded-md border p-3 md:col-span-1">
          <p className="text-xs text-muted-foreground">Goods Value (by Currency)</p>
          {totals.currencies.length
            ? totals.currencies.map(([ccy, value]) => <p key={ccy} className="text-sm font-semibold tabular-nums">{formatGoods(value, ccy)}</p>)
            : <p className="text-sm text-muted-foreground">—</p>}
        </div>
      </div>
      {totals.estimatedCount > 0 && (
        <p className="mb-4 text-xs text-muted-foreground">
          Some goods values are estimates (weight × rate) where final payable was not entered. Different currencies are not combined.
        </p>
      )}
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading...</div>
      ) : isError ? (
        <div className="flex items-center justify-center gap-3 py-8 text-sm text-destructive">
          Could not load factory containers.
          <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No containers match the selected filters.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Container #</TableHead><TableHead>Supplier</TableHead><TableHead>Status</TableHead>
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
                        <TableCell className="text-right font-mono text-xs">{formatQty(number(container.totalKg) ?? 0, 3)} kg</TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {amount ? `${formatGoods(amount.amount, container.currencyCode || "USD")}${amount.estimated ? " *" : ""}` : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow className="bg-muted/30 font-medium">
                    <TableCell colSpan={3}>{group.name} — {group.rows.length} containers</TableCell>
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
                <div key={container.id} className="rounded-md border p-3" data-testid={`factory-report-container-mobile-${container.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-mono text-sm font-semibold">{container.containerNumber}</span>
                    <span className="text-xs text-muted-foreground">{factoryReportStatus(container.status)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{container.supplierName || "No Supplier"}</p>
                  <div className="mt-2 flex justify-between gap-2 border-t pt-2 text-xs">
                    <span>{formatQty(number(container.totalKg) ?? 0, 3)} kg</span>
                    <span className="font-mono">{amount ? `${formatGoods(amount.amount, container.currencyCode || "USD")}${amount.estimated ? " *" : ""}` : "—"}</span>
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
