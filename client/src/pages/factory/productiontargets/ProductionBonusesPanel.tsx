import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCheck, Coins, Filter, Loader2, LockKeyhole, Search, SlidersHorizontal, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { ProductionBonusCategoryRatesPanel } from "./ProductionBonusCategoryRatesPanel";
import { queryClient } from "@/lib/queryClient";

type Decision = "approved" | "rejected";
type Status = "pending" | Decision;
interface BonusRow {
  date: string;
  workerId: number;
  workerName: string;
  category: string;
  linkGroupId: number | null;
  targetBales: number;
  producedBales: number;
  extraBales: number;
  ratePerBale: number | null;
  proposedAmount: number;
  status: Status;
  reviewedBy: string | null;
  reviewedAt: string | null;
  lockedAmount: number | null;
}
interface BonusResponse {
  start: string;
  end: string;
  rows: BonusRow[];
  totals: {
    workers: number; extraBales: number;
    pendingAmount: number; approvedAmount: number;
    pendingCount: number; approvedCount: number; rejectedCount: number;
  };
  canDecide: boolean;
}
const EMPTY_BONUS_ROWS: BonusRow[] = [];
const rowKey = (row: BonusRow) => row.date + ":" + row.workerId;
const money = (amount: number) => "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (amount: number) => amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, path, body);
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.message || "Production bonus request failed");
  }
  return response.json() as Promise<T>;
}

/**
 * Production Targets bonus review — NOT a payout surface.
 * The server is the sole calculation/authorization authority.
 */
export function ProductionBonusesPanel({ initialDate }: { initialDate: string }) {
  const { toast } = useToast();
  const [start, setStart] = useState(initialDate);
  const [end, setEnd] = useState(initialDate);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | Status | "eligible">("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDecision, setConfirmDecision] = useState<Decision | null>(null);
  const [rateWorker, setRateWorker] = useState<BonusRow | null>(null);
  const [rateInput, setRateInput] = useState("");
  const [rateDate, setRateDate] = useState(initialDate);

  useEffect(() => {
    setStart(initialDate);
    setEnd(initialDate);
    setSelected([]);
  }, [initialDate]);

  const rangeValid = Boolean(start && end && start <= end) &&
    (Date.parse(end) - Date.parse(start)) / 86400000 <= 31;
  const { data, isLoading, error } = useQuery<BonusResponse>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses", start, end],
    queryFn: () => api<BonusResponse>(
      "GET", "/api/factory/staff-tracking/production-bonuses?" +
        new URLSearchParams({ start, end }).toString()
    ),
    enabled: rangeValid,
  });

  const rows = data?.rows ?? EMPTY_BONUS_ROWS;
  const visible = useMemo(() => rows.filter((row) => {
    const needle = search.trim().toLocaleLowerCase();
    const matchesName = !needle ||
      row.workerName.toLocaleLowerCase().includes(needle) ||
      row.category.toLocaleLowerCase().includes(needle) ||
      row.date.includes(needle);
    if (!matchesName) return false;
    if (filter === "eligible") return row.status === "pending" && row.extraBales > 0;
    return filter === "all" || row.status === filter;
  }), [rows, search, filter]);
  const eligible = visible.filter((row) => row.status === "pending" && row.extraBales > 0);
  const selectedRows = rows.filter((row) =>
    selected.includes(rowKey(row)) && row.status === "pending" && row.extraBales > 0
  );
  const allVisibleSelected = eligible.length > 0 &&
    eligible.every((row) => selected.includes(rowKey(row)));

  // Weekly/date-range worker totals combine historically linked and unlinked
  // days without counting the displayed linked-team production twice.
  const workerBreakdown = useMemo(() => {
    const grouped = new Map<number, {
      workerId: number; name: string; target: number; produced: number; extra: number;
      pending: number; approved: number;
    }>();
    for (const row of rows) {
      const current = grouped.get(row.workerId) ?? {
        workerId: row.workerId, name: row.workerName, target: 0, produced: 0, extra: 0, pending: 0, approved: 0,
      };
      current.target += row.targetBales;
      current.produced += row.producedBales;
      current.extra += row.extraBales;
      if (row.status === "pending") current.pending += row.proposedAmount;
      if (row.status === "approved") current.approved += row.lockedAmount ?? 0;
      grouped.set(row.workerId, current);
    }
    return [...grouped.values()].sort((a, b) => b.extra - a.extra || a.name.localeCompare(b.name));
  }, [rows]);

  const reviewMutation = useMutation({
    mutationFn: async (decision: Decision) =>
      api<{ saved: number; unchanged: number }>(
        "POST", "/api/factory/staff-tracking/production-bonuses/decide",
        { decisions: selectedRows.map((row) => ({
          date: row.date, workerId: row.workerId, decision, expectedAmount: row.proposedAmount,
        })) }
      ),
    onSuccess: ({ saved, unchanged }) => {
      toast({ title: "Production bonus decisions saved", description: `${saved} reviewed, ${unchanged} already decided.` });
      setSelected([]);
      setConfirmDecision(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses"] });
    },
    onError: (err: Error) => {
      setConfirmDecision(null);
      toast({ title: "Could not save decisions", description: err.message, variant: "destructive" });
    },
  });

  const rateMutation = useMutation({
    mutationFn: () =>
      api("POST", "/api/factory/staff-tracking/production-bonuses/rate", {
        workerId: rateWorker!.workerId, effectiveFrom: rateDate, ratePerBale: rateInput,
      }),
    onSuccess: () => {
      toast({ title: "Worker bonus rate saved" });
      setRateWorker(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses"] });
    },
    onError: (err: Error) =>
      toast({ title: "Rate not saved", description: err.message, variant: "destructive" }),
  });
  const canApproveSelected = selectedRows.length > 0 && selectedRows.every((row) =>
    row.extraBales > 0 && row.ratePerBale != null && row.ratePerBale > 0
  );
  const selectedAmount = selectedRows.reduce((total, row) => total + row.proposedAmount, 0);

  // Keep worker compensation information entirely out of non-admin UI.
  if (data && !data.canDecide) return null;

  return (
    <Card className="overflow-hidden shadow-none" data-testid="production-bonuses-panel">
      <CardHeader className="space-y-1 border-b bg-muted/20 pb-4">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Production Bonuses</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Review finalized days only. Bonuses are based on each worker's own attributed bales above their target,
          including their individual share when workers are linked. Approval locks the amount; it does not make a payment.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {data?.canDecide && <ProductionBonusCategoryRatesPanel initialDate={initialDate} />}
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            From
            <Input aria-label="Production bonus from" type="date" value={start} onChange={(event) => {
              setStart(event.target.value); setSelected([]);
            }} className="w-[155px]" />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            To
            <Input aria-label="Production bonus to" type="date" value={end} onChange={(event) => {
              setEnd(event.target.value); setSelected([]);
            }} className="w-[155px]" />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Filter className="h-3.5 w-3.5" /> Review status</span>
            <Select value={filter} onValueChange={(value) => { setFilter(value as typeof filter); setSelected([]); }}>
              <SelectTrigger className="w-[156px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="eligible">Needs review</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <div className="relative min-w-[170px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search bonus worker" value={search} placeholder="Worker, category or date"
              onChange={(event) => setSearch(event.target.value)} className="pl-9" />
          </div>
        </div>
        {!rangeValid && <p role="alert" className="text-sm text-destructive">Choose a valid range of up to 32 days.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[
            ["Extra bales", count(data?.totals.extraBales ?? 0)],
            ["Pending review", String(data?.totals.pendingCount ?? 0)],
            ["Pending bonus", money(data?.totals.pendingAmount ?? 0)],
            ["Approved bonus", money(data?.totals.approvedAmount ?? 0)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border bg-muted/10 px-3 py-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        {workerBreakdown.length > 0 && (
          <details className="rounded-md border bg-muted/10">
            <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium">
              Worker totals across selected dates ({workerBreakdown.length} workers)
            </summary>
            <div className="overflow-x-auto border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Worker</TableHead>
                    <TableHead className="text-right">Target</TableHead>
                    <TableHead className="text-right">Produced</TableHead>
                    <TableHead className="text-right">Extra</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    <TableHead className="text-right">Approved</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workerBreakdown.map((worker) => (
                    <TableRow key={worker.workerId}>
                      <TableCell className="font-medium">{worker.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{count(worker.target)}</TableCell>
                      <TableCell className="text-right tabular-nums">{count(worker.produced)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{count(worker.extra)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(worker.pending)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(worker.approved)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </details>
        )}
        {data?.canDecide && (
          <div className="flex flex-wrap items-center gap-2 border-b pb-3">
            <Button size="sm" variant="outline" onClick={() => setSelected(
              allVisibleSelected
                ? selected.filter((key) => !eligible.some((row) => rowKey(row) === key))
                : Array.from(new Set([...selected, ...eligible.map(rowKey)]))
            )} disabled={eligible.length === 0}>
              {allVisibleSelected ? "Unselect visible" : "Select all needing review"}
            </Button>
            <span className="mr-auto text-xs text-muted-foreground">
              {selectedRows.length} selected · {money(selectedAmount)} proposed
            </span>
            <Button size="sm" disabled={!canApproveSelected || reviewMutation.isPending}
              onClick={() => setConfirmDecision("approved")}>
              <CheckCheck className="mr-1.5 h-4 w-4" /> Approve
            </Button>
            <Button size="sm" variant="outline" disabled={selectedRows.length === 0 || reviewMutation.isPending}
              onClick={() => setConfirmDecision("rejected")}>
              <XCircle className="mr-1.5 h-4 w-4" /> Reject
            </Button>
          </div>
        )}
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {data?.canDecide && <TableHead className="w-10">Select</TableHead>}
                <TableHead>Date / Worker</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="text-right">Made</TableHead>
                <TableHead className="text-right">Extra</TableHead>
                <TableHead className="text-right">Rate / bale</TableHead>
                <TableHead className="text-right">Bonus</TableHead>
                <TableHead>Status / Audit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">Loading finalized production...</TableCell></TableRow>
              ) : visible.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  No finalized worker production in this range.
                </TableCell></TableRow>
              ) : visible.map((row) => {
                const actionable = row.status === "pending" && row.extraBales > 0;
                return (
                  <TableRow key={rowKey(row)}>
                    {data?.canDecide && <TableCell>
                      <Checkbox aria-label={`Select ${row.workerName} on ${row.date}`}
                        checked={selected.includes(rowKey(row))}
                        disabled={!actionable}
                        onCheckedChange={(checked) => setSelected((previous) =>
                          checked ? Array.from(new Set([...previous, rowKey(row)])) :
                            previous.filter((key) => key !== rowKey(row))
                        )} />
                    </TableCell>}
                    <TableCell>
                      <p className="font-medium">{row.workerName}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.date}{row.linkGroupId != null && " · linked worker"}
                      </p>
                    </TableCell>
                    <TableCell>{row.category || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(row.targetBales)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(row.producedBales)}</TableCell>
                    <TableCell className={`text-right font-semibold tabular-nums ${row.extraBales > 0 ? "text-emerald-600" : ""}`}>
                      {count(row.extraBales)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="tabular-nums">{row.ratePerBale == null ? "Not set" : money(row.ratePerBale)}</span>
                      {data?.canDecide && row.status === "pending" &&
                        <Button variant="ghost" size="sm" className="ml-1 h-7 px-1.5"
                          title="Change effective-dated per-bale rate"
                          onClick={() => { setRateWorker(row); setRateInput(row.ratePerBale?.toString() ?? ""); setRateDate(row.date); }}>
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                        </Button>}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {row.status === "rejected" ? money(0) :
                        money(row.status === "approved" ? (row.lockedAmount ?? 0) : row.proposedAmount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.status === "approved" ? "default" : "secondary"}>
                        {row.status === "pending" && row.extraBales === 0 ? "No extra bales" :
                          row.status === "pending" && row.ratePerBale == null ? "Rate needed" : row.status}
                      </Badge>
                      {row.reviewedAt && <p className="mt-1 text-[11px] text-muted-foreground">
                        <LockKeyhole className="mr-1 inline h-3 w-3" />
                        {row.reviewedBy || "Reviewer"} · {new Date(row.reviewedAt).toLocaleString()}
                      </p>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          Decisions are permanent audit records. Rejected bonuses pay $0. Select a payment account and post the
          approved expense only in the separate payment workflow.
        </p>
      </CardContent>

      <Dialog open={rateWorker != null} onOpenChange={(open) => { if (!open) setRateWorker(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Worker rate per extra bale</DialogTitle>
            <DialogDescription>
              This rate applies from the selected date onward. Reviewed bonus records cannot be recalculated.
            </DialogDescription>
          </DialogHeader>
          <p className="font-medium">{rateWorker?.workerName}</p>
          <label className="space-y-1 text-sm">
            Effective from
            <Input aria-label="Bonus rate effective date" type="date" value={rateDate}
              onChange={(event) => setRateDate(event.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            Rate per extra bale ($)
            <Input aria-label="Bonus rate per bale" type="number" inputMode="decimal"
              min="0.0001" step="0.0001" value={rateInput}
              onChange={(event) => setRateInput(event.target.value)} />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRateWorker(null)}>Cancel</Button>
            <Button disabled={rateMutation.isPending || !rateInput || Number(rateInput) <= 0}
              onClick={() => rateMutation.mutate()}>
              {rateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save rate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDecision != null} onOpenChange={(open) => { if (!open) setConfirmDecision(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDecision === "approved" ? "Confirm production bonus approval" : "Confirm production bonus rejection"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are about to {confirmDecision === "approved" ? "approve" : "reject"} {selectedRows.length}
              {selectedRows.length === 1 ? " worker bonus" : " worker bonuses"} totaling {money(selectedAmount)}.
              This saves an immutable historical decision. No money is paid or posted now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reviewMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={reviewMutation.isPending || selectedRows.length === 0}
              onClick={(event) => { event.preventDefault(); if (confirmDecision) reviewMutation.mutate(confirmDecision); }}>
              {reviewMutation.isPending ? "Saving..." : "Confirm decision"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
