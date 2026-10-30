import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileDown, History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import {
  buildProductionTargetBonusReport, isBonusReportDate,
  type ProductionTargetBonusReport, type ProductionTargetBonusStatus,
} from "@shared/productionTargetBonusReporting";
import { addIsoDays } from "../factoryProductionTargetsModel";
import { factoryProductionToday } from "./productionWeeklyExcel";
import { exportProductionBonusHistoryExcel } from "./productionBonusHistoryExcel";

const statuses: ProductionTargetBonusStatus[] =
  ["DRAFT", "PENDING", "APPROVED", "POSTED", "REJECTED", "VOIDED"];
const dateRangeValid = (start: string, end: string) =>
  isBonusReportDate(start) && isBonusReportDate(end) && start <= end &&
  (Date.parse(end + "T12:00:00Z") - Date.parse(start + "T12:00:00Z")) / 86400000 < 366;
const money = (value: string, currency: string) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number(value)) + " " + currency;

/**
 * Phase 7 standalone report component. Mount inside the privileged Production
 * Targets area during phase 8 after the authoritative bonus ledger/report
 * loader is registered. Do not show this panel to pressing workers.
 */
export function ProductionBonusHistoryPanel() {
  const { toast } = useToast();
  const [start, setStart] = useState(() => addIsoDays(factoryProductionToday(), -29));
  const [end, setEnd] = useState(() => factoryProductionToday());
  const [worker, setWorker] = useState("all");
  const [status, setStatus] = useState("all");
  const [exporting, setExporting] = useState(false);
  const valid = dateRangeValid(start, end);

  const { data, isLoading, error, refetch } = useQuery<ProductionTargetBonusReport>({
    queryKey: ["/api/factory/production-target-bonuses/report", start, end],
    enabled: valid,
    queryFn: async () => {
      const params = new URLSearchParams({ start, end });
      const response = await factoryApiRequest("GET",
        "/api/factory/production-target-bonuses/report?" + params.toString());
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Unable to load bonus history");
      }
      return response.json();
    },
  });

  const selected = useMemo(() => {
    if (!valid || !data) return null;
    const rows = data.rows.filter(row =>
      (worker === "all" || String(row.workerId) === worker) &&
      (status === "all" || row.status === status));
    return buildProductionTargetBonusReport(start, end, rows, data.generatedAt);
  }, [data, start, end, status, worker, valid]);

  const exportExcel = async () => {
    if (!selected || exporting) return;
    setExporting(true);
    try {
      await exportProductionBonusHistoryExcel(selected);
      toast({ title: "Production bonus history exported" });
    } catch (e: unknown) {
      toast({ title: "Excel export failed", description: e instanceof Error ? e.message : String(e),
        variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="space-y-4" data-testid="production-bonus-history">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <History className="h-5 w-5" /> Production Bonus History
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Worker statements, proposed bonuses, approved unpaid amounts and posted payments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void refetch()} disabled={!valid || isLoading}>
            Refresh
          </Button>
          <Button onClick={() => void exportExcel()} disabled={!selected?.rows.length || exporting || isLoading}>
            {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> :
              <FileDown className="mr-2 h-4 w-4" />}
            Export formatted Excel
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-xs text-muted-foreground">Production from
          <Input type="date" value={start} onChange={e => setStart(e.target.value)} data-testid="bonus-report-from" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">Production through
          <Input type="date" value={end} onChange={e => setEnd(e.target.value)} data-testid="bonus-report-to" />
        </label>
        <div className="space-y-1 text-xs text-muted-foreground">
          <span>Worker statement</span>
          <Select value={worker} onValueChange={setWorker}>
            <SelectTrigger data-testid="bonus-report-worker"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All workers</SelectItem>
              {[...new Map((data?.rows ?? []).map(row => [row.workerId, row.workerNameSnapshot])).entries()]
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([id, name]) => <SelectItem key={id} value={String(id)}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <span>Review/payment status</span>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger data-testid="bonus-report-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statuses.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {!valid && <p className="text-sm text-destructive">Select valid dates in order, up to 366 days.</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Loading saved bonus history…</p>}
      {error && <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Unable to load bonus history"}
      </p>}

      {selected && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(selected.currencies.length ? selected.currencies : []).flatMap(summary => [
              { key: "accepted", title: "Accepted", value: summary.accepted, currency: summary.currency },
              { key: "unpaid", title: "Approved · unpaid", value: summary.approvedUnpaid, currency: summary.currency },
              { key: "paid", title: "Posted · paid", value: summary.paid, currency: summary.currency },
              { key: "pending", title: "Pending proposal", value: summary.pendingProposed, currency: summary.currency },
            ]).map(summary => (
              <Card key={summary.currency + summary.key} className="shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs uppercase text-muted-foreground">{summary.title} · {summary.currency}</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums">
                    {money(summary.value, summary.currency)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Date</TableHead><TableHead>Worker</TableHead><TableHead>Target</TableHead>
                <TableHead>Credited</TableHead><TableHead>Extra</TableHead><TableHead>Rate</TableHead>
                <TableHead>Bonus</TableHead><TableHead>Status</TableHead>
                <TableHead>Paid from</TableHead><TableHead>Voucher</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {selected.rows.map(row => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">{row.productionDate}</TableCell>
                    <TableCell className="min-w-[150px]">{row.workerNameSnapshot}</TableCell>
                    <TableCell className="tabular-nums">{row.targetBales}</TableCell>
                    <TableCell className="tabular-nums">{row.creditedBales}</TableCell>
                    <TableCell className="tabular-nums">{row.excessBales}</TableCell>
                    <TableCell className="tabular-nums">{row.bonusPerExtraBale} {row.currency}</TableCell>
                    <TableCell className="font-medium tabular-nums">{money(row.amount, row.currency)}</TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell>{row.status === "POSTED" ? row.paymentAccountNameSnapshot : "—"}</TableCell>
                    <TableCell>{row.status === "POSTED" ?
                      row.paymentVoucherNumber || row.paymentVoucherId : "—"}</TableCell>
                  </TableRow>
                ))}
                {selected.rows.length === 0 && (
                  <TableRow><TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    No production bonus awards match these dates and filters.
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Worker statement</TableHead><TableHead>Currency</TableHead>
                <TableHead>Accepted</TableHead><TableHead>Unpaid</TableHead>
                <TableHead>Paid</TableHead><TableHead>Pending proposal</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {selected.workers.map(row => <TableRow key={row.workerId + ":" + row.currency}>
                  <TableCell>{row.workerName}</TableCell><TableCell>{row.currency}</TableCell>
                  <TableCell>{money(row.accepted, row.currency)}</TableCell>
                  <TableCell>{money(row.approvedUnpaid, row.currency)}</TableCell>
                  <TableCell>{money(row.paid, row.currency)}</TableCell>
                  <TableCell>{money(row.pendingProposed, row.currency)}</TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Totals are for bonuses earned in this date range, with payment status as of{" "}
            {data?.generatedAt ? new Date(data.generatedAt).toLocaleString() : "the latest refresh"}.
            Pending proposals are not payable. A posted bonus is counted as paid only when its
            Deposit Expense voucher and payment account are recorded. Historical rates are not recalculated.
          </p>
        </>
      )}
    </section>
  );
}
