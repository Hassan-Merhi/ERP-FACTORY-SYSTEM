import { useState, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {} from "@/components/ui/command";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ChevronDown, Package, Scale } from "lucide-react";
import React from "react";
import { cn } from "@/lib/utils";

import type { MergedRow, Preset, ProductRow, ReportData, SupplierDayRow } from "./productioncomparison/types";
import {
  deriveGrade,
  fmtDateRange,
  fmtKg,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtUsd,
  lastMonthRange,
  lastYearRange,
  pctChange,
  thisMonthRange,
  thisYearRange,
  todayStr,
  yesterdayStr,
} from "./productioncomparison/utils";
import { MultiSelectFilter } from "./productioncomparison/components/MultiSelectFilter";
import { DiffCell } from "./productioncomparison/components/DiffCell";
import { StatCard } from "./productioncomparison/components/StatCard";
import { buildWorkerSummaryByArticle, WorkerSummaryHover } from "./productioncomparison/components/WorkerSummaryHover";
// ── Date helpers ─────────────────────────────────────────────────────────────

export default function ProductionComparison() {
  const [preset, setPreset] = useState<Preset>("month");

  const [customA, setCustomA] = useState<[string, string]>([todayStr(), todayStr()]);
  const [customB, setCustomB] = useState<[string, string]>([yesterdayStr(), yesterdayStr()]);

  // Filters — multi-select for category and grade
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterGrades, setFilterGrades] = useState<string[]>([]);
  const [filterProduct, setFilterProduct] = useState("");
  // Worker filter (multi-select by worker ID)
  const [filterWorkers, setFilterWorkers] = useState<string[]>([]);
  // Supplier mix breakdown filter
  const [filterSuppliers, setFilterSuppliers] = useState<string[]>([]);

  const { data: workers = [] } = useQuery<{ id: number; fullName: string; active?: boolean }[]>({
    queryKey: ["/api/factory/workers?profile=picker"],
    staleTime: 60_000,
  });

  const { data: baleProducts = [] } = useQuery<
    Array<{ code: string; articleCode?: string | null; nameAr?: string | null }>
  >({
    queryKey: ["/api/factory/bale-products?profile=picker"],
    staleTime: 60_000,
  });

  // Worker categories — the filter only offers the pressing-team workers.
  const { data: workerCategories = [] } = useQuery<{ id: number; name: string; workerIds: number[] }[]>({
    queryKey: ["/api/factory/worker-categories"],
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch("/api/factory/worker-categories", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load worker categories");
      return r.json();
    },
  });

  // Only workers belonging to a "pressing" category are selectable.  When no such
  // category exists yet, fall back to every active worker so the filter still works.
  const workerOptions = useMemo(() => {
    const pressingIds = new Set<number>();
    for (const cat of workerCategories) {
      if (!(cat.name || "").toLowerCase().includes("pressing")) continue;
      for (const id of Array.isArray(cat.workerIds) ? cat.workerIds : []) pressingIds.add(Number(id));
    }
    const active = workers.filter((w) => w.active !== false);
    const pool = pressingIds.size > 0 ? active.filter((w) => pressingIds.has(w.id)) : active;
    return pool
      .slice()
      .sort((a, b) => (a.fullName || "").localeCompare(b.fullName || ""))
      .map((w) => ({ value: String(w.id), label: w.fullName }));
  }, [workers, workerCategories]);

  const arabicNameByArticle = useMemo(() => {
    const map = new Map<string, string>();
    const add = (key: string | null | undefined, nameAr: string | null | undefined) => {
      const normalized = (key || "").trim().toUpperCase();
      const name = (nameAr || "").trim();
      if (normalized && name) map.set(normalized, name);
    };
    for (const product of baleProducts) {
      add(product.articleCode, product.nameAr);
      add(product.code, product.nameAr);
    }
    return map;
  }, [baleProducts]);

  // Stable key for the query cache / request param.
  const workerIdsParam = useMemo(() => [...filterWorkers].sort().join(","), [filterWorkers]);

  const [rangeA, rangeB] = useMemo<[[string, string], [string, string]]>(() => {
    if (preset === "today-yesterday")
      return [
        [todayStr(), todayStr()],
        [yesterdayStr(), yesterdayStr()],
      ];
    if (preset === "month") return [thisMonthRange(), lastMonthRange()];
    if (preset === "year") return [thisYearRange(), lastYearRange()];
    return [customA, customB];
  }, [preset, customA, customB]);

  const labelA =
    preset === "today-yesterday"
      ? "Today"
      : preset === "month"
        ? "This Month"
        : preset === "year"
          ? "This Year"
          : "Period A";
  const labelB =
    preset === "today-yesterday"
      ? "Yesterday"
      : preset === "month"
        ? "Last Month"
        : preset === "year"
          ? "Last Year"
          : "Period B";

  const qA = useQuery<ReportData>({
    queryKey: ["/api/factory/production-value-report", rangeA[0], rangeA[1], workerIdsParam, "production-comparison"],
    staleTime: 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({ from: rangeA[0], to: rangeA[1], view: "production-comparison" });
      if (workerIdsParam) params.set("workerIds", workerIdsParam);
      const r = await fetch(`/api/factory/production-value-report?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? "Request failed");
      return r.json();
    },
  });

  const qB = useQuery<ReportData>({
    queryKey: ["/api/factory/production-value-report", rangeB[0], rangeB[1], workerIdsParam, "production-comparison"],
    staleTime: 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({ from: rangeB[0], to: rangeB[1], view: "production-comparison" });
      if (workerIdsParam) params.set("workerIds", workerIdsParam);
      const r = await fetch(`/api/factory/production-value-report?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? "Request failed");
      return r.json();
    },
  });

  const isLoading = qA.isLoading || qB.isLoading;
  const fetchError = qA.error || qB.error;
  const costsHidden = Boolean(qA.data?.costsHidden || qB.data?.costsHidden);

  const { categories, grades } = useMemo(() => {
    const catSet = new Set<string>();
    const gradeSet = new Set<string>();
    for (const row of [...(qA.data?.production.byProduct ?? []), ...(qB.data?.production.byProduct ?? [])]) {
      if (row.categoryName) catSet.add(row.categoryName);
      const g = deriveGrade(row.articleCode);
      if (g !== "—") gradeSet.add(g);
    }
    return { categories: [...catSet].sort(), grades: [...gradeSet].sort() };
  }, [qA.data, qB.data]);

  const workerSummaryByArticle = useMemo(
    () => buildWorkerSummaryByArticle(qA.data?.production.byProduct ?? [], qB.data?.production.byProduct ?? []),
    [qA.data, qB.data]
  );

  const mergedAll = useMemo<MergedRow[]>(() => {
    const map = new Map<string, MergedRow>();
    // Worker names are accumulated across both periods, ordered by bale count.
    const workerTally = new Map<string, Map<string, number>>();
    const tallyWorkers = (row: ProductRow) => {
      let t = workerTally.get(row.articleCode);
      if (!t) workerTally.set(row.articleCode, (t = new Map()));
      for (const w of row.workers ?? []) {
        if (!w?.name) continue;
        t.set(w.name, (t.get(w.name) ?? 0) + (w.qty ?? 0));
      }
    };

    for (const row of qA.data?.production.byProduct ?? []) {
      map.set(row.articleCode, {
        articleCode: row.articleCode,
        productName: row.productName,
        categoryName: row.categoryName,
        grade: deriveGrade(row.articleCode),
        aQty: row.qty,
        bQty: 0,
        aKg: row.totalWeightKg,
        bKg: 0,
        workers: [],
      });
      tallyWorkers(row);
    }
    for (const row of qB.data?.production.byProduct ?? []) {
      const ex = map.get(row.articleCode);
      if (ex) {
        ex.bQty = row.qty;
        ex.bKg = row.totalWeightKg;
      } else {
        map.set(row.articleCode, {
          articleCode: row.articleCode,
          productName: row.productName,
          categoryName: row.categoryName,
          grade: deriveGrade(row.articleCode),
          aQty: 0,
          bQty: row.qty,
          aKg: 0,
          bKg: row.totalWeightKg,
          workers: [],
        });
      }
      tallyWorkers(row);
    }

    for (const row of map.values()) {
      const t = workerTally.get(row.articleCode);
      row.workers = t ? [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n) : [];
    }
    return [...map.values()];
  }, [qA.data, qB.data]);

  const filtered = useMemo(
    () =>
      mergedAll
        .filter((r) => filterCategories.length === 0 || filterCategories.includes(r.categoryName))
        .filter((r) => filterGrades.length === 0 || filterGrades.includes(r.grade))
        .filter((r) => {
          if (!filterProduct) return true;
          const q = filterProduct.toLowerCase();
          const arabicName = arabicNameByArticle.get(r.articleCode.trim().toUpperCase()) ?? "";
          return (
            r.articleCode.toLowerCase().includes(q) ||
            r.productName.toLowerCase().includes(q) ||
            arabicName.toLowerCase().includes(q)
          );
        })
        .sort((a, b) => (a.productName || a.articleCode).localeCompare(b.productName || b.articleCode)),
    [mergedAll, filterCategories, filterGrades, filterProduct, arabicNameByArticle]
  );

  const totalABales = filtered.reduce((s, r) => s + r.aQty, 0);
  const totalBBales = filtered.reduce((s, r) => s + r.bQty, 0);
  const totalAKg = filtered.reduce((s, r) => s + r.aKg, 0);
  const totalBKg = filtered.reduce((s, r) => s + r.bKg, 0);
  const baleDiff = totalABales - totalBBales;
  const kgDiff = totalAKg - totalBKg;
  const balePct = pctChange(totalABales, totalBBales);
  const kgPct = pctChange(totalAKg, totalBKg);

  // ── Profit ──
  const profitA = costsHidden ? null : (qA.data?.summary?.statusValue ?? null);
  const profitB = costsHidden ? null : (qB.data?.summary?.statusValue ?? null);
  const profitDiff = profitA != null && profitB != null ? profitA - profitB : null;

  // ── Supplier mix breakdown ──
  const allSuppliers = useMemo(() => {
    const s = new Set<string>();
    for (const r of [...(qA.data?.supplierMixBreakdown ?? []), ...(qB.data?.supplierMixBreakdown ?? [])]) {
      if (r.supplierName) s.add(r.supplierName);
    }
    return [...s].sort();
  }, [qA.data, qB.data]);

  const supplierBreakdownA = useMemo(() => {
    const rows = (qA.data?.supplierMixBreakdown ?? []).filter(
      (r) => filterSuppliers.length === 0 || filterSuppliers.includes(r.supplierName)
    );
    return rows;
  }, [qA.data, filterSuppliers]);

  const supplierBreakdownB = useMemo(() => {
    const rows = (qB.data?.supplierMixBreakdown ?? []).filter(
      (r) => filterSuppliers.length === 0 || filterSuppliers.includes(r.supplierName)
    );
    return rows;
  }, [qB.data, filterSuppliers]);

  // Merged supplier summary: per-supplier totals for A and B
  const supplierSummary = useMemo(() => {
    const map = new Map<string, { supplier: string; aKg: number; aCost: number; bKg: number; bCost: number }>();
    const add = (rows: SupplierDayRow[], period: "a" | "b") => {
      for (const r of rows) {
        const ex = map.get(r.supplierName);
        if (ex) {
          if (period === "a") {
            ex.aKg += r.totalKg;
            ex.aCost += r.totalCost ?? 0;
          } else {
            ex.bKg += r.totalKg;
            ex.bCost += r.totalCost ?? 0;
          }
        } else {
          map.set(
            r.supplierName,
            period === "a"
              ? { supplier: r.supplierName, aKg: r.totalKg, aCost: r.totalCost ?? 0, bKg: 0, bCost: 0 }
              : { supplier: r.supplierName, aKg: 0, aCost: 0, bKg: r.totalKg, bCost: r.totalCost }
          );
        }
      }
    };
    add(supplierBreakdownA, "a");
    add(supplierBreakdownB, "b");
    return [...map.values()].sort((a, b) => a.supplier.localeCompare(b.supplier));
  }, [supplierBreakdownA, supplierBreakdownB]);

  // Per-day breakdown (combined A+B rows, labelled by period)
  const dailyBreakdown = useMemo(() => {
    const rows: Array<SupplierDayRow & { period: string }> = [
      ...supplierBreakdownA.map((r) => ({ ...r, period: labelA })),
      ...supplierBreakdownB.map((r) => ({ ...r, period: labelB })),
    ];
    return rows.sort((a, b) =>
      a.date !== b.date
        ? a.date.localeCompare(b.date)
        : a.period !== b.period
          ? a.period.localeCompare(b.period)
          : a.supplierName.localeCompare(b.supplierName)
    );
  }, [supplierBreakdownA, supplierBreakdownB, labelA, labelB]);

  const totalSupAKg = supplierBreakdownA.reduce((s, r) => s + r.totalKg, 0);
  const totalSupACost = supplierBreakdownA.reduce((s, r) => s + (r.totalCost ?? 0), 0);
  const totalSupBKg = supplierBreakdownB.reduce((s, r) => s + r.totalKg, 0);
  const totalSupBCost = supplierBreakdownB.reduce((s, r) => s + (r.totalCost ?? 0), 0);
  const totalSupKgDiff = totalSupAKg - totalSupBKg;
  const totalSupCostDiff = totalSupACost - totalSupBCost;

  const hasActiveFilter =
    filterCategories.length > 0 || filterGrades.length > 0 || filterProduct !== "" || filterWorkers.length > 0;
  const hasSupplierFilter = filterSuppliers.length > 0;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {/* Header + preset buttons */}
      <PageHeader title="Production Comparison" subtitle="Compare output across two time periods">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["today-yesterday", "Today vs Yesterday"],
              ["month", "This Month vs Last Month"],
              ["year", "This Year vs Last Year"],
              ["custom", "Custom"],
            ] as [Preset, string][]
          ).map(([p, label]) => (
            <Button key={p} variant={preset === p ? "default" : "outline"} size="sm" onClick={() => setPreset(p)}>
              {label}
            </Button>
          ))}
        </div>
      </PageHeader>

      {/* Custom date pickers */}
      {preset === "custom" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border bg-muted/40 p-4">
          <div className="space-y-2">
            <p className="text-sm font-semibold">Period A</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                className="rounded-md border bg-background px-2.5 py-1.5 text-sm"
                value={customA[0]}
                onChange={(e) => setCustomA([e.target.value, customA[1]])}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                className="rounded-md border bg-background px-2.5 py-1.5 text-sm"
                value={customA[1]}
                onChange={(e) => setCustomA([customA[0], e.target.value])}
              />
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold">Period B</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                className="rounded-md border bg-background px-2.5 py-1.5 text-sm"
                value={customB[0]}
                onChange={(e) => setCustomB([e.target.value, customB[1]])}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                className="rounded-md border bg-background px-2.5 py-1.5 text-sm"
                value={customB[1]}
                onChange={(e) => setCustomB([customB[0], e.target.value])}
              />
            </div>
          </div>
        </div>
      )}

      {/* Loading skeletons */}
      {isLoading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      )}

      {/* Error state */}
      {!isLoading && fetchError && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Failed to load production data</p>
            <p className="text-xs mt-0.5 opacity-80">{(fetchError as Error).message}</p>
          </div>
        </div>
      )}

      {/* Content */}
      {!isLoading && !fetchError && (
        <>
          {/* Row 1: Period A & B — bales with kg underneath */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <StatCard
              title={labelA}
              value={fmtNum(totalABales) + " bales"}
              sub={fmtDateRange(rangeA[0], rangeA[1])}
              icon={<Package className="h-4 w-4" />}
              extraLine={{ label: "Weight:", value: `${fmtKg(totalAKg)} kg` }}
            />
            <StatCard
              title={labelB}
              value={fmtNum(totalBBales) + " bales"}
              sub={fmtDateRange(rangeB[0], rangeB[1])}
              icon={<Package className="h-4 w-4" />}
              extraLine={{ label: "Weight:", value: `${fmtKg(totalBKg)} kg` }}
            />
          </div>

          {/* Row 2: bale diff, kg diff, % change */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              title="Bale Difference"
              value={`${baleDiff > 0 ? "+" : ""}${fmtNum(baleDiff)}`}
              sub={`${labelA} vs ${labelB}`}
              accent={baleDiff > 0 ? "green" : baleDiff < 0 ? "red" : "neutral"}
              icon={<Package className="h-4 w-4" />}
              valueClass={baleDiff > 0 ? "text-emerald-600" : baleDiff < 0 ? "text-red-500" : "text-muted-foreground"}
            />
            <StatCard
              title="Kilogram Difference"
              value={`${kgDiff > 0 ? "+" : ""}${fmtKg(kgDiff)} kg`}
              sub={`${labelA} vs ${labelB}`}
              accent={kgDiff > 0 ? "green" : kgDiff < 0 ? "red" : "neutral"}
              icon={<Scale className="h-4 w-4" />}
              valueClass={kgDiff > 0 ? "text-emerald-600" : kgDiff < 0 ? "text-red-500" : "text-muted-foreground"}
            />
            <StatCard
              title="% Change"
              value={fmtPct(balePct)}
              sub={`Bales · Kg: ${fmtPct(kgPct)}`}
              accent={(balePct ?? 0) > 0 ? "green" : (balePct ?? 0) < 0 ? "red" : "neutral"}
              valueClass={
                (balePct ?? 0) > 0 ? "text-emerald-600" : (balePct ?? 0) < 0 ? "text-red-500" : "text-muted-foreground"
              }
            />
          </div>

          {/* Row 3: Production Profit */}
          {!costsHidden && (profitA != null || profitB != null) && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatCard
                title={`${labelA} — Production Profit`}
                value={profitA != null ? fmtMoney(profitA) : "—"}
                sub={fmtDateRange(rangeA[0], rangeA[1])}
                accent={profitA != null ? (profitA > 0 ? "green" : profitA < 0 ? "red" : "neutral") : undefined}
                valueClass={
                  profitA == null
                    ? "text-muted-foreground"
                    : profitA > 0
                      ? "text-emerald-600"
                      : profitA < 0
                        ? "text-red-500"
                        : "text-muted-foreground"
                }
              />
              <StatCard
                title={`${labelB} — Production Profit`}
                value={profitB != null ? fmtMoney(profitB) : "—"}
                sub={fmtDateRange(rangeB[0], rangeB[1])}
                accent={profitB != null ? (profitB > 0 ? "green" : profitB < 0 ? "red" : "neutral") : undefined}
                valueClass={
                  profitB == null
                    ? "text-muted-foreground"
                    : profitB > 0
                      ? "text-emerald-600"
                      : profitB < 0
                        ? "text-red-500"
                        : "text-muted-foreground"
                }
              />
              <StatCard
                title="Profit Difference"
                value={profitDiff != null ? fmtMoney(profitDiff) : "—"}
                sub={`${labelA} vs ${labelB}`}
                accent={
                  profitDiff != null ? (profitDiff > 0 ? "green" : profitDiff < 0 ? "red" : "neutral") : undefined
                }
                valueClass={
                  profitDiff == null
                    ? "text-muted-foreground"
                    : profitDiff > 0
                      ? "text-emerald-600"
                      : profitDiff < 0
                        ? "text-red-500"
                        : "text-muted-foreground"
                }
              />
            </div>
          )}

          {/* ── Mix by Supplier ── */}
          {(supplierBreakdownA.length > 0 || supplierBreakdownB.length > 0) && (
            <div className="rounded-lg border overflow-hidden">
              {/* Header row */}
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-muted/30">
                <div>
                  <p className="text-sm font-semibold">Raw Material by Supplier</p>
                  <p className="text-xs text-muted-foreground">
                    Mix batch usage per supplier · {labelA}: {fmtKg(totalSupAKg)} kg
                    {!costsHidden && <> / {fmtUsd(totalSupACost)}</>}
                    {" · "}
                    {labelB}: {fmtKg(totalSupBKg)} kg
                    {!costsHidden && <> / {fmtUsd(totalSupBCost)}</>}
                  </p>
                </div>
                <MultiSelectFilter
                  options={allSuppliers}
                  selected={filterSuppliers}
                  onChange={setFilterSuppliers}
                  placeholder="Suppliers"
                  allLabel="All Suppliers"
                  className="w-44 shrink-0"
                />
              </div>

              {/* Supplier summary table */}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">{labelA} — kg</TableHead>
                    {!costsHidden && <TableHead className="text-right">{labelA} — cost</TableHead>}
                    <TableHead className="text-right">{labelB} — kg</TableHead>
                    {!costsHidden && <TableHead className="text-right">{labelB} — cost</TableHead>}
                    <TableHead className="text-right">Kg Diff</TableHead>
                    {!costsHidden && <TableHead className="text-right">Cost Diff</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {supplierSummary.map((row) => {
                    const kd = row.aKg - row.bKg;
                    const cd = row.aCost - row.bCost;
                    return (
                      <TableRow key={row.supplier}>
                        <TableCell className="font-medium">{row.supplier}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtKg(row.aKg)} kg</TableCell>
                        {!costsHidden && (
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {fmtUsd(row.aCost)}
                          </TableCell>
                        )}
                        <TableCell className="text-right tabular-nums">{fmtKg(row.bKg)} kg</TableCell>
                        {!costsHidden && (
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {fmtUsd(row.bCost)}
                          </TableCell>
                        )}
                        <TableCell className="text-right">
                          <DiffCell value={kd} fmt={(n) => `${n > 0 ? "+" : ""}${fmtKg(n)} kg`} />
                        </TableCell>
                        {!costsHidden && (
                          <TableCell className="text-right">
                            <DiffCell value={cd} fmt={(n) => `${n > 0 ? "+" : ""}${fmtUsd(Math.abs(n))}`} />
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                  {supplierSummary.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={costsHidden ? 4 : 7} className="text-center text-muted-foreground py-6 text-sm">
                        {hasSupplierFilter ? "No data for selected suppliers." : "No mix batch data."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
                {supplierSummary.length > 0 && (
                  <TableFooter>
                    <TableRow className="border-t-2 bg-muted/40 hover:bg-muted/40">
                      <TableCell className="font-bold uppercase text-xs tracking-wider">
                        Total ({supplierSummary.length} supplier{supplierSummary.length === 1 ? "" : "s"})
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-bold">{fmtKg(totalSupAKg)} kg</TableCell>
                      {!costsHidden && (
                        <TableCell className="text-right tabular-nums font-bold">{fmtUsd(totalSupACost)}</TableCell>
                      )}
                      <TableCell className="text-right tabular-nums font-bold">{fmtKg(totalSupBKg)} kg</TableCell>
                      {!costsHidden && (
                        <TableCell className="text-right tabular-nums font-bold">{fmtUsd(totalSupBCost)}</TableCell>
                      )}
                      <TableCell className="text-right font-bold">
                        <DiffCell value={totalSupKgDiff} fmt={(n) => `${n > 0 ? "+" : ""}${fmtKg(n)} kg`} />
                      </TableCell>
                      {!costsHidden && (
                        <TableCell className="text-right font-bold">
                          <DiffCell value={totalSupCostDiff} fmt={(n) => `${n > 0 ? "+" : ""}${fmtUsd(Math.abs(n))}`} />
                        </TableCell>
                      )}
                    </TableRow>
                  </TableFooter>
                )}
              </Table>

              {/* Daily detail (collapsible-style: always shown when ≤30 rows, hidden behind toggle otherwise) */}
              {dailyBreakdown.length > 0 && (
                <details className="group">
                  <summary className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground cursor-pointer border-t hover:bg-muted/20 select-none list-none">
                    <ChevronDown className="h-3.5 w-3.5 group-open:rotate-180 transition-transform" />
                    Per-day breakdown ({dailyBreakdown.length} rows)
                  </summary>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[110px]">Date</TableHead>
                          <TableHead className="w-[80px]">Period</TableHead>
                          <TableHead>Supplier</TableHead>
                          <TableHead className="text-right">kg Used</TableHead>
                          {!costsHidden && <TableHead className="text-right">Cost</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {dailyBreakdown.map((r, i) => (
                          <TableRow key={i}>
                            <TableCell className="tabular-nums text-sm">{r.date}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs font-normal">
                                {r.period}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-medium text-sm">{r.supplierName}</TableCell>
                            <TableCell className="text-right tabular-nums text-sm">{fmtKg(r.totalKg)} kg</TableCell>
                            {!costsHidden && (
                              <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                                {fmtUsd(r.totalCost ?? 0)}
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </details>
              )}
            </div>
          )}

          {/* ── Bale filters ── */}
          <div className="flex flex-wrap gap-3 items-center">
            <MultiSelectFilter
              options={categories}
              selected={filterCategories}
              onChange={setFilterCategories}
              placeholder="Categories"
              allLabel="All Categories"
              className="w-48"
            />

            <MultiSelectFilter
              options={grades}
              selected={filterGrades}
              onChange={setFilterGrades}
              placeholder="Grades"
              allLabel="All Grades"
              className="w-36"
            />

            <MultiSelectFilter
              options={workerOptions}
              selected={filterWorkers}
              onChange={setFilterWorkers}
              placeholder="Workers"
              allLabel="All Workers"
              className="w-44"
            />

            <Input
              placeholder="Search product…"
              className="w-52"
              value={filterProduct}
              onChange={(e) => setFilterProduct(e.target.value)}
            />

            {hasActiveFilter && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilterCategories([]);
                  setFilterGrades([]);
                  setFilterProduct("");
                  setFilterWorkers([]);
                }}
              >
                Clear filters
              </Button>
            )}

            {hasActiveFilter && (
              <span className="text-xs text-muted-foreground">
                {filtered.length} of {mergedAll.length} products
              </span>
            )}
          </div>

          {/* ── Bale comparison table ── */}
          {filtered.length === 0 ? (
            <div className="rounded-xl border p-12 text-center text-sm text-muted-foreground">
              {mergedAll.length === 0
                ? "No production data found for either period."
                : "No products match the active filters."}
            </div>
          ) : (
            <div className="rounded-xl border overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    {/* Group row */}
                    <tr className="bg-muted/40 border-b border-border">
                      <th
                        rowSpan={2}
                        className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground min-w-[200px] border-r border-border/50 align-bottom"
                      >
                        Product
                      </th>
                      <th
                        rowSpan={2}
                        className="px-3 py-3 text-right text-xs font-bold uppercase tracking-wider text-muted-foreground border-r border-border/50 align-bottom min-w-[180px]"
                      >
                        Product (Arabic)
                      </th>
                      <th
                        rowSpan={2}
                        className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground border-r border-border/50 align-bottom"
                      >
                        Category
                      </th>
                      <th
                        rowSpan={2}
                        className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground border-r border-border/50 align-bottom"
                      >
                        Grade
                      </th>
                      <th
                        rowSpan={2}
                        className="px-3 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground border-r border-border/50 align-bottom min-w-[100px]"
                      >
                        Workers
                      </th>
                      <th
                        colSpan={3}
                        className="px-4 py-2 text-center text-xs font-bold uppercase tracking-widest text-blue-600 dark:text-blue-400 border-b border-border/50 border-r border-border/50"
                      >
                        Quantity (Bales)
                      </th>
                      <th
                        colSpan={3}
                        className="px-4 py-2 text-center text-xs font-bold uppercase tracking-widest text-violet-600 dark:text-violet-400 border-b border-border/50"
                      >
                        Weight (kg)
                      </th>
                    </tr>
                    {/* Sub-header row */}
                    <tr className="bg-muted/20 border-b border-border">
                      <th className="px-4 py-2 text-right text-xs font-semibold text-foreground whitespace-nowrap">
                        {labelA}
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {labelB}
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-foreground border-r border-border/50">
                        Diff
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-foreground whitespace-nowrap">
                        {labelA}
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {labelB}
                      </th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-foreground">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row, idx) => {
                      const qDiff = row.aQty - row.bQty;
                      const kDiff = row.aKg - row.bKg;
                      const workerSummary = workerSummaryByArticle.get(row.articleCode) ?? [];
                      const arabicName = arabicNameByArticle.get(row.articleCode.trim().toUpperCase()) ?? "";
                      return (
                        <tr
                          key={row.articleCode}
                          className={cn(
                            "border-b border-border/30 hover:bg-accent/40 transition-colors",
                            idx % 2 === 1 && "bg-muted/10"
                          )}
                        >
                          <td className="px-4 py-2.5 border-r border-border/30">
                            <span className="font-medium text-sm leading-snug">
                              {row.productName || row.articleCode}
                            </span>
                          </td>
                          <td
                            className="px-3 py-2.5 text-sm text-right border-r border-border/30 min-w-[180px]"
                            dir="rtl"
                          >
                            <span className={arabicName ? "font-medium" : "text-muted-foreground"}>
                              {arabicName || "—"}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-sm text-muted-foreground border-r border-border/30">
                            {row.categoryName || "—"}
                          </td>
                          <td className="px-3 py-2.5 border-r border-border/30">
                            {row.grade !== "—" ? (
                              <Badge variant="secondary" className="text-xs font-semibold px-2">
                                {row.grade}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 border-r border-border/30">
                            <WorkerSummaryHover workers={workerSummary} labelA={labelA} labelB={labelB} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-foreground">
                            {fmtNum(row.aQty)}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                            {fmtNum(row.bQty)}
                          </td>
                          <td className="px-4 py-2.5 text-right border-r border-border/30">
                            <DiffCell value={qDiff} fmt={(n) => (n > 0 ? "+" : "") + fmtNum(n)} />
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-foreground">
                            {fmtKg(row.aKg)}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                            {fmtKg(row.bKg)}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <DiffCell value={kDiff} fmt={(n) => (n > 0 ? "+" : "") + fmtKg(n)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
