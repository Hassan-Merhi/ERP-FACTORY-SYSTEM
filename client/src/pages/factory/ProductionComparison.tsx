import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {} from "@/components/ui/command";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ChevronDown, Package, Scale, BarChart3, TrendingUp, Coins, Download, Layers3 } from "lucide-react";
import React from "react";
import { cn } from "@/lib/utils";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";

import type { MergedRow, Preset, ReportData, SupplierDayRow } from "./productioncomparison/types";
import {
  deriveGrade,
  fmtDateRange,
  fmtKg,
  fmtMoney,
  fmtNum,
  fmtUsd,
  lastMonthRange,
  lastYearRange,
  mergeProductionPeriods,
  thisMonthRange,
  thisYearRange,
  todayStr,
  yesterdayStr,
} from "./productioncomparison/utils";
import { MultiSelectFilter } from "./productioncomparison/components/MultiSelectFilter";
import { BaleComparisonFilters } from "./productioncomparison/components/BaleComparisonFilters";
import { DiffCell } from "./productioncomparison/components/DiffCell";
import { StatCard } from "./productioncomparison/components/StatCard";
import { ComparisonPresetPicker } from "./productioncomparison/components/ComparisonPresetPicker";
import { PeriodOverviewCard } from "./productioncomparison/components/PeriodOverviewCard";
import { SupplierDailyTrend } from "./productioncomparison/components/SupplierDailyTrend";
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
  const isPhoneLayout = useErpPhoneLayout();
  const [phoneTableView, setPhoneTableView] = useState(false);
  const comparisonCards = useMobileCardTable(!phoneTableView);

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

  const mergedAll = useMemo<MergedRow[]>(
    () => mergeProductionPeriods(qA.data?.production.byProduct ?? [], qB.data?.production.byProduct ?? []),
    [qA.data, qB.data]
  );

  const filtered = useMemo(
    () =>
      mergedAll
        .filter((r) => filterCategories.length === 0 || filterCategories.includes(r.categoryName))
        .filter((r) => filterGrades.length === 0 || filterGrades.includes(r.grade))
        .filter((r) => {
          if (!filterProduct) return true;
          const arabicName = arabicNameByArticle.get(r.articleCode.trim().toUpperCase()) ?? "";
          return searchAny(filterProduct, r.articleCode, r.productName, arabicName);
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

  // ── Batch KPI (follows the same category/grade/product/worker filters as production) ──
  const linkedBatchMapA = useMemo(
    () => new Map((qA.data?.production.linkedBatches ?? []).map((batch) => [batch.id, batch.totalWeightKg] as const)),
    [qA.data]
  );
  const linkedBatchMapB = useMemo(
    () => new Map((qB.data?.production.linkedBatches ?? []).map((batch) => [batch.id, batch.totalWeightKg] as const)),
    [qB.data]
  );

  const filteredBatchIdsA = useMemo(() => {
    const ids = new Set<number>();
    for (const row of filtered) {
      for (const id of row.aMixBatchIds) {
        if (linkedBatchMapA.has(id)) ids.add(id);
      }
    }
    return ids;
  }, [filtered, linkedBatchMapA]);

  const filteredBatchIdsB = useMemo(() => {
    const ids = new Set<number>();
    for (const row of filtered) {
      for (const id of row.bMixBatchIds) {
        if (linkedBatchMapB.has(id)) ids.add(id);
      }
    }
    return ids;
  }, [filtered, linkedBatchMapB]);

  const totalABatches = filteredBatchIdsA.size;
  const totalBBatches = filteredBatchIdsB.size;
  const totalABatchAmount = [...filteredBatchIdsA].reduce((sum, id) => sum + (linkedBatchMapA.get(id) ?? 0), 0);
  const totalBBatchAmount = [...filteredBatchIdsB].reduce((sum, id) => sum + (linkedBatchMapB.get(id) ?? 0), 0);

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
              : { supplier: r.supplierName, aKg: 0, aCost: 0, bKg: r.totalKg, bCost: r.totalCost ?? 0 }
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

  const hasSupplierFilter = filterSuppliers.length > 0;

  /** CSV respects the selected supplier filter and cost-field permissions. */
  function exportSupplierCsv() {
    const header = ["Supplier", labelA + " KG", labelB + " KG", "KG Difference", "KG Change %"];
    if (!costsHidden) header.push(labelA + " Cost USD", labelA + " Rate/KG", labelB + " Cost USD", labelB + " Rate/KG", "Cost Difference USD");
    const rows = supplierSummary.map((row) => {
      const values = [
        row.supplier,
        String(row.aKg),
        String(row.bKg),
        String(row.aKg - row.bKg),
        row.bKg > 0 ? String(((row.aKg - row.bKg) / row.bKg) * 100) : "",
      ];
      if (!costsHidden) {
        values.push(
          String(row.aCost),
          row.aKg > 0 ? String(row.aCost / row.aKg) : "",
          String(row.bCost),
          row.bKg > 0 ? String(row.bCost / row.bKg) : "",
          String(row.aCost - row.bCost)
        );
      }
      return values;
    });
    const escapeCell = (value: string) => {
      // Avoid CSV formula injection when opening supplier names in Excel.
      const safe = /^[\s]*[=+\-@\t\r]/.test(value) ? "'" + value : value;
      return '"' + safe.replace(/"/g, '""') + '"';
    };
    const csv = [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "production-supplier-comparison.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 p-3 sm:p-4 lg:p-5" data-testid="production-comparison-dashboard">
      {/* Header + preset buttons */}
      <div className="relative overflow-hidden rounded-2xl border border-blue-500/20 bg-gradient-to-r from-blue-50 via-slate-50 to-indigo-50 p-4 dark:from-[#101d31] dark:via-[#111b2c] dark:to-[#161c35] sm:p-5">
        <div className="pointer-events-none absolute -right-10 -top-16 h-48 w-72 rounded-full bg-blue-400/10 blur-3xl" />
        <div className="relative flex min-w-0 items-center gap-3 [&_[data-testid=page-header]]:mb-0 [&_[data-testid=page-header]]:w-full [&_[data-testid=page-header]]:border-none [&_[data-testid=page-header]]:pb-0">
          <PageHeader
            title="Production Comparison"
            subtitle="Compare output, weight, cost and profit across selected periods"
            icon={<span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-md shadow-blue-500/20"><BarChart3 className="h-6 w-6" /></span>}
          >
            <ComparisonPresetPicker preset={preset} onChange={setPreset} />
          </PageHeader>
        </div>
      </div>

      {/* Custom date pickers */}
      {preset === "custom" && (
        <div className="grid grid-cols-1 gap-4 rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-semibold">Period A</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                className="rounded-lg border bg-background px-3 py-2 text-sm"
                value={customA[0]}
                onChange={(e) => setCustomA([e.target.value, customA[1]])}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                className="rounded-lg border bg-background px-3 py-2 text-sm"
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
                className="rounded-lg border bg-background px-3 py-2 text-sm"
                value={customB[0]}
                onChange={(e) => setCustomB([e.target.value, customB[1]])}
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                className="rounded-lg border bg-background px-3 py-2 text-sm"
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
          {/* Period cards: the bars represent real product quantities, not invented history. */}
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <PeriodOverviewCard
              label={labelA}
              range={fmtDateRange(rangeA[0], rangeA[1])}
              bales={totalABales}
              kilograms={totalAKg}
              products={qA.data?.production.byProduct ?? []}
              tone="blue"
            />
            <PeriodOverviewCard
              label={labelB}
              range={fmtDateRange(rangeB[0], rangeB[1])}
              bales={totalBBales}
              kilograms={totalBKg}
              products={qB.data?.production.byProduct ?? []}
              tone="violet"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            <StatCard
              title="Bale Difference"
              value={(baleDiff > 0 ? "+" : "") + fmtNum(baleDiff)}
              sub={labelA + " vs " + labelB + (totalBBales > 0 ? " · " + ((baleDiff / totalBBales) * 100).toFixed(1) + "%" : "")}
              accent={baleDiff > 0 ? "green" : baleDiff < 0 ? "red" : "neutral"}
              tone="emerald"
              icon={<Package className="h-5 w-5" />}
              valueClass={baleDiff > 0 ? "text-emerald-600 dark:text-emerald-300" : baleDiff < 0 ? "text-red-600 dark:text-red-300" : ""}
            />
            <StatCard
              title="Kilogram Difference"
              value={(kgDiff > 0 ? "+" : "") + fmtKg(kgDiff) + " kg"}
              sub={labelA + " vs " + labelB + (totalBKg > 0 ? " · " + ((kgDiff / totalBKg) * 100).toFixed(1) + "%" : "")}
              accent={kgDiff > 0 ? "green" : kgDiff < 0 ? "red" : "neutral"}
              tone="blue"
              icon={<Scale className="h-5 w-5" />}
              valueClass={kgDiff > 0 ? "text-emerald-600 dark:text-emerald-300" : kgDiff < 0 ? "text-red-600 dark:text-red-300" : ""}
            />
            {!costsHidden && (profitA != null || profitB != null) && (
              <>
                <StatCard
                  title={labelA + " — Production Profit"}
                  value={profitA != null ? fmtMoney(profitA) : "—"}
                  sub={fmtDateRange(rangeA[0], rangeA[1])}
                  tone="amber"
                  accent={profitA != null ? profitA > 0 ? "green" : profitA < 0 ? "red" : "neutral" : "neutral"}
                  valueClass={profitA != null ? profitA > 0 ? "text-emerald-600 dark:text-emerald-300" : profitA < 0 ? "text-red-600 dark:text-red-300" : "" : ""}
                  icon={<Coins className="h-5 w-5" />}
                />
                <StatCard
                  title={labelB + " — Production Profit"}
                  value={profitB != null ? fmtMoney(profitB) : "—"}
                  sub={fmtDateRange(rangeB[0], rangeB[1])}
                  tone="violet"
                  accent={profitB != null ? profitB > 0 ? "green" : profitB < 0 ? "red" : "neutral" : "neutral"}
                  valueClass={profitB != null ? profitB > 0 ? "text-emerald-600 dark:text-emerald-300" : profitB < 0 ? "text-red-600 dark:text-red-300" : "" : ""}
                  icon={<Coins className="h-5 w-5" />}
                />
                <StatCard
                  title="Profit Difference"
                  value={profitDiff != null ? fmtMoney(profitDiff) : "—"}
                  sub={labelA + " vs " + labelB + (profitDiff != null && profitB != null && profitB !== 0 ? " · " + ((profitDiff / Math.abs(profitB)) * 100).toFixed(1) + "%" : "")}
                  tone="teal"
                  accent={profitDiff != null ? profitDiff > 0 ? "green" : profitDiff < 0 ? "red" : "neutral" : "neutral"}
                  valueClass={profitDiff != null ? profitDiff > 0 ? "text-emerald-600 dark:text-emerald-300" : profitDiff < 0 ? "text-red-600 dark:text-red-300" : "" : ""}
                  icon={<TrendingUp className="h-5 w-5" />}
                />
              </>
            )}
          </div>
          {/* Existing batch metrics remain available and keep the same filters. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border/60 bg-muted/25 px-4 py-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-2 font-semibold text-foreground"><Layers3 className="h-4 w-4 text-blue-500" /> Mix batches</span>
            <span><strong className="text-foreground">{labelA}:</strong> {fmtNum(totalABatches)} batches / {fmtKg(totalABatchAmount)} kg</span>
            <span><strong className="text-foreground">{labelB}:</strong> {fmtNum(totalBBatches)} batches / {fmtKg(totalBBatchAmount)} kg</span>
            <span className="sm:ml-auto">Responds to production filters</span>
          </div>

          {/* ── Mix by Supplier ── */}
          {(supplierBreakdownA.length > 0 || supplierBreakdownB.length > 0) && (
            <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm dark:bg-[#101a29]">
              {/* Supplier comparison; all financial fields obey cost visibility. */}
              <div className="flex flex-col gap-3 border-b border-border/70 bg-gradient-to-r from-blue-500/[0.05] to-violet-500/[0.04] px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-300">
                    <Layers3 className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-bold tracking-tight">Raw Material by Supplier</h3>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      Mix batch usage · {labelA}: {fmtKg(totalSupAKg)} kg
                      {!costsHidden && <> / {fmtUsd(totalSupACost)}</>}
                      {" · "}
                      {labelB}: {fmtKg(totalSupBKg)} kg
                      {!costsHidden && <> / {fmtUsd(totalSupBCost)}</>}
                    </p>
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <MultiSelectFilter
                    options={allSuppliers}
                    selected={filterSuppliers}
                    onChange={setFilterSuppliers}
                    placeholder="Suppliers"
                    allLabel="All Suppliers"
                    className="w-44 shrink-0"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-lg border-blue-500/30 bg-blue-600 text-white hover:bg-blue-700 hover:text-white dark:bg-blue-600 dark:hover:bg-blue-500"
                    onClick={exportSupplierCsv}
                    disabled={supplierSummary.length === 0}
                    data-testid="button-export-supplier-comparison"
                  >
                    <Download className="mr-1.5 h-4 w-4" /> Export CSV
                  </Button>
                </div>
              </div>

              <Table mobileLayout="cards" className="text-xs" wrapperClassName="overflow-x-auto">
                <TableHeader>
                  <TableRow className="bg-slate-100/80 hover:bg-slate-100/80 dark:bg-[#18283e] dark:hover:bg-[#18283e]">
                    <TableHead className="w-9">#</TableHead>
                    <TableHead className="min-w-[150px] font-semibold">Supplier</TableHead>
                    <TableHead className="min-w-[105px] text-right font-semibold text-blue-700 dark:text-sky-300">{labelA} · KG</TableHead>
                    {!costsHidden && <TableHead className="text-right font-semibold text-blue-700 dark:text-sky-300">{labelA} · Cost</TableHead>}
                    {!costsHidden && <TableHead className="text-right font-semibold text-blue-700 dark:text-sky-300">{labelA} · Rate/kg</TableHead>}
                    <TableHead className="text-right font-semibold text-violet-700 dark:text-violet-300">{labelB} · KG</TableHead>
                    {!costsHidden && <TableHead className="text-right font-semibold text-violet-700 dark:text-violet-300">{labelB} · Cost</TableHead>}
                    {!costsHidden && <TableHead className="text-right font-semibold text-violet-700 dark:text-violet-300">{labelB} · Rate/kg</TableHead>}
                    <TableHead className="text-right font-semibold">KG Diff</TableHead>
                    {!costsHidden && <TableHead className="text-right font-semibold">Cost Diff</TableHead>}
                    <TableHead className="text-right font-semibold">% Change</TableHead>
                    <TableHead className="text-right font-semibold">Daily Trend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {supplierSummary.map((row, index) => {
                    const kd = row.aKg - row.bKg;
                    const cd = row.aCost - row.bCost;
                    const percent = row.bKg > 0 ? (kd / row.bKg) * 100 : null;
                    return (
                      <TableRow key={row.supplier} className="border-border/40 transition-colors hover:bg-blue-500/[0.04] dark:hover:bg-blue-500/[0.08]">
                        <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                        <TableCell className="font-semibold">{row.supplier}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{fmtKg(row.aKg)} kg</TableCell>
                        {!costsHidden && <TableCell className="text-right tabular-nums text-muted-foreground">{fmtUsd(row.aCost)}</TableCell>}
                        {!costsHidden && <TableCell className="text-right tabular-nums text-muted-foreground">{row.aKg > 0 ? "$" + (row.aCost / row.aKg).toFixed(4) : "—"}</TableCell>}
                        <TableCell className="text-right tabular-nums">{fmtKg(row.bKg)} kg</TableCell>
                        {!costsHidden && <TableCell className="text-right tabular-nums text-muted-foreground">{fmtUsd(row.bCost)}</TableCell>}
                        {!costsHidden && <TableCell className="text-right tabular-nums text-muted-foreground">{row.bKg > 0 ? "$" + (row.bCost / row.bKg).toFixed(4) : "—"}</TableCell>}
                        <TableCell className="text-right">
                          <DiffCell value={kd} fmt={(n) => (n > 0 ? "+" : "") + fmtKg(n) + " kg"} />
                        </TableCell>
                        {!costsHidden && <TableCell className="text-right"><DiffCell value={cd} fmt={(n) => (n > 0 ? "+" : "") + fmtUsd(Math.abs(n))} /></TableCell>}
                        <TableCell className="text-right">
                          {percent == null ? (
                            <span className="text-muted-foreground">{row.aKg > 0 ? "New" : "—"}</span>
                          ) : (
                            <span className={cn("font-semibold tabular-nums", percent > 0 ? "text-emerald-600 dark:text-emerald-300" : percent < 0 ? "text-red-500 dark:text-red-300" : "text-muted-foreground")}>
                              {percent > 0 ? "+" : ""}{percent.toFixed(1)}%
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <SupplierDailyTrend rows={supplierBreakdownA} supplier={row.supplier} increased={kd >= 0} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {supplierSummary.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={costsHidden ? 7 : 12} className="py-8 text-center text-sm text-muted-foreground">
                        {hasSupplierFilter ? "No data for selected suppliers." : "No mix batch data."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
                {supplierSummary.length > 0 && (
                  <TableFooter>
                    <TableRow className="border-t-2 border-blue-500/30 bg-blue-600/10 font-bold hover:bg-blue-600/15 dark:bg-blue-600/20 dark:hover:bg-blue-600/25">
                      <TableCell className="text-blue-700 dark:text-blue-100">∑</TableCell>
                      <TableCell className="whitespace-nowrap font-bold text-blue-700 dark:text-blue-100">Total ({supplierSummary.length} suppliers)</TableCell>
                      <TableCell className="text-right font-bold tabular-nums">{fmtKg(totalSupAKg)} kg</TableCell>
                      {!costsHidden && <TableCell className="text-right font-bold tabular-nums">{fmtUsd(totalSupACost)}</TableCell>}
                      {!costsHidden && <TableCell className="text-right font-bold tabular-nums">{totalSupAKg > 0 ? "$" + (totalSupACost / totalSupAKg).toFixed(4) : "—"}</TableCell>}
                      <TableCell className="text-right font-bold tabular-nums">{fmtKg(totalSupBKg)} kg</TableCell>
                      {!costsHidden && <TableCell className="text-right font-bold tabular-nums">{fmtUsd(totalSupBCost)}</TableCell>}
                      {!costsHidden && <TableCell className="text-right font-bold tabular-nums">{totalSupBKg > 0 ? "$" + (totalSupBCost / totalSupBKg).toFixed(4) : "—"}</TableCell>}
                      <TableCell className="text-right font-bold"><DiffCell value={totalSupKgDiff} fmt={(n) => (n > 0 ? "+" : "") + fmtKg(n) + " kg"} /></TableCell>
                      {!costsHidden && <TableCell className="text-right font-bold"><DiffCell value={totalSupCostDiff} fmt={(n) => (n > 0 ? "+" : "") + fmtUsd(Math.abs(n))} /></TableCell>}
                      <TableCell className="text-right font-bold tabular-nums">
                        {totalSupBKg > 0 ? ((totalSupKgDiff / totalSupBKg) * 100).toFixed(1) + "%" : "—"}
                      </TableCell>
                      <TableCell className="text-right"><SupplierDailyTrend rows={supplierBreakdownA} increased={totalSupKgDiff >= 0} /></TableCell>
                    </TableRow>
                  </TableFooter>
                )}
              </Table>

              {/* Daily detail (collapsible-style: always shown when ≤30 rows, hidden behind toggle otherwise) */}
              {dailyBreakdown.length > 0 && (
                <details className="group">
                  <summary className="flex cursor-pointer list-none select-none items-center gap-2 border-t border-border/70 bg-muted/20 px-4 py-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/40">
                    <ChevronDown className="h-3.5 w-3.5 group-open:rotate-180 transition-transform" />
                    Per-day breakdown ({dailyBreakdown.length} rows)
                  </summary>
                  <div className="overflow-x-auto">
                    <Table mobileLayout="cards">
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
          <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-sm sm:p-4">
          <BaleComparisonFilters
            categories={categories}
            grades={grades}
            workerOptions={workerOptions}
            filterCategories={filterCategories}
            setFilterCategories={setFilterCategories}
            filterGrades={filterGrades}
            setFilterGrades={setFilterGrades}
            filterWorkers={filterWorkers}
            setFilterWorkers={setFilterWorkers}
            filterProduct={filterProduct}
            setFilterProduct={setFilterProduct}
            shownCount={filtered.length}
            totalCount={mergedAll.length}
          />
          </div>

          {/* ── Bale comparison table ── */}
          {filtered.length === 0 ? (
            <div className="rounded-xl border p-12 text-center text-sm text-muted-foreground">
              {mergedAll.length === 0
                ? "No production data found for either period."
                : "No products match the active filters."}
            </div>
          ) : (
            <div className="space-y-2">
              {/* Phones read one card per product by default; the full matrix stays one tap away. */}
              {isPhoneLayout && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-pressed={phoneTableView}
                    onClick={() => setPhoneTableView((current) => !current)}
                    data-testid="button-comparison-table-view"
                  >
                    {phoneTableView ? "Card view" : "Table view"}
                  </Button>
                </div>
              )}
              <div className={cn("overflow-hidden", !comparisonCards.cards && "rounded-2xl border border-border/70 bg-card shadow-sm")}>
                <div className="overflow-x-auto">
                  <table
                    className="w-full border-collapse text-sm"
                    {...comparisonCards.tableProps}
                    data-testid="table-production-comparison"
                  >
                    <thead>
                      {/* Group row */}
                      <tr className="border-b border-border bg-blue-500/[0.055] dark:bg-[#15263b]">
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
                      <tr className="border-b border-border bg-violet-500/[0.035] dark:bg-[#142238]">
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
