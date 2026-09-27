/**
 * RepaymentsView — extracted sub-component.
 *
 * Extracted from FactoryAdvancesTab.tsx during the Phase 4 god-file split.
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Banknote, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { FactoryWorker } from "@shared/schema";

import type { RepaymentRecord } from "../types";
import { fmt } from "../utils";

export function RepaymentsView() {
  const { formatDisplayDate } = useDateFormat();
  const [filterWorker, setFilterWorker] = useState("all");

  const { data: workers } = useQuery<FactoryWorker[]>({
    queryKey: ["/api/factory/workers"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers?active=true", { credentials: "include" });
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: repayments, isLoading } = useQuery<RepaymentRecord[]>({
    queryKey: ["/api/factory/advance-repayments", filterWorker],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterWorker !== "all") params.set("workerId", filterWorker);
      const url = `/api/factory/advance-repayments${params.toString() ? `?${params}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to load repayments");
      }
      return res.json();
    },
  });

  const stats = useMemo(() => {
    const all = Array.isArray(repayments) ? repayments : [];
    const totalRepaid = all.reduce((s, r) => s + parseFloat(r.amount || "0"), 0);
    return { totalRepaid, count: all.length };
  }, [repayments]);

  const formatDate = (val: string | null | undefined) => {
    if (!val) return "\u2014";
    try {
      return formatDisplayDate(val);
    } catch {
      return "\u2014";
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-24 rounded-md" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-md" />
      </div>
    );
  }

  const list = Array.isArray(repayments) ? repayments : [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-md bg-green-100 dark:bg-green-900/30">
              <RotateCcw className="h-5 w-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Repaid</p>
              <p className="text-lg font-bold" data-testid="text-repayments-total">
                {fmt(stats.totalRepaid)}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-md bg-blue-100 dark:bg-blue-900/30">
              <Banknote className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Repayments</p>
              <p className="text-lg font-bold" data-testid="text-repayments-count">
                {stats.count}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={filterWorker} onValueChange={setFilterWorker}>
          <SelectTrigger className="w-48" data-testid="select-repayments-filter-worker">
            <SelectValue placeholder="All Workers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Workers</SelectItem>
            {(workers || []).map((w) => (
              <SelectItem key={w.id} value={String(w.id)}>
                {w.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Worker</TableHead>
                  <TableHead>Loan Date</TableHead>
                  <TableHead>Repayment Date</TableHead>
                  <TableHead className="text-right">Amount Paid</TableHead>
                  <TableHead>Cash Account</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      No repayments found
                    </TableCell>
                  </TableRow>
                ) : (
                  list.map((r) => (
                    <TableRow key={r.id} data-testid={`row-repayment-${r.id}`}>
                      <TableCell className="font-medium" data-testid={`text-repayment-worker-${r.id}`}>
                        {r.workerName}
                      </TableCell>
                      <TableCell data-testid={`text-repayment-loan-date-${r.id}`}>
                        {formatDate(r.advanceDate)}
                      </TableCell>
                      <TableCell data-testid={`text-repayment-date-${r.id}`}>{formatDate(r.repaymentDate)}</TableCell>
                      <TableCell className="text-right font-mono" data-testid={`text-repayment-amount-${r.id}`}>
                        {fmt(r.amount)}
                      </TableCell>
                      <TableCell
                        className="text-sm text-muted-foreground"
                        data-testid={`text-repayment-account-${r.id}`}
                      >
                        {r.cashAccountName || "\u2014"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                        {r.notes || "\u2014"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
